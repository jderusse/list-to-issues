import { type Address, uniqueAddresses } from "../addresses";
import { type App, attachmentPrefix, ref } from "../app";
import { hashId } from "../crypto";
import { verifyEchoHeader } from "../echo";
import { ACK, backoff, type InboundJob, type JobResult, retryIn } from "../jobs";
import { setReportStatus, statusLabel } from "../status";
import type { MessageRow, Thread } from "../store";
import { type ParsedMail, parseMail } from "./parse";
import { renderMail } from "./render";

// How many times a reply waits for its parent before it opens an issue of its own
const PARENT_RETRIES = 3;
const PARENT_DELAY = 60;

function marker(hash: string, part: number): string {
	return `<!-- list-to-issues:${hash}:${part} -->`;
}

function othersIn(mail: ParsedMail, app: App, reporter: string): Address[] {
	return uniqueAddresses(mail.recipients, [app.cfg.listAddress, app.cfg.inboundAddress, app.cfg.senderAddress, reporter]);
}

async function storeAttachments(mail: ParsedMail, indexes: number[], r2Key: string, app: App): Promise<void> {
	for (const index of indexes) {
		const attachment = mail.attachments[index]!;
		await app.raw.put(`${attachmentPrefix(r2Key)}${index}`, attachment.content, {
			customMetadata: { name: encodeURIComponent(attachment.filename).slice(0, 600) },
		});
	}
}

// The comments that an earlier attempt already posted for this message, by part number.
async function postedParts(issue: number, hash: string, since: string, app: App): Promise<Map<number, number>> {
	const found = new Map<number, number>();
	const pattern = new RegExp(`<!-- list-to-issues:${hash}:(\\d+) -->`);
	const from = new Date(Date.parse(since) - 600_000).toISOString();
	for (const comment of await app.github.listComments(issue, from)) {
		const match = pattern.exec(comment.body);
		if (null !== match) {
			found.set(Number(match[1]), comment.id);
		}
	}

	return found;
}

async function postComments(issue: number, parts: string[], firstPart: number, hash: string, posted: Map<number, number>, app: App): Promise<number | null> {
	let first: number | null = null;
	for (let i = 0; i < parts.length; i++) {
		const part = firstPart + i;
		const id = posted.get(part) ?? (await app.github.createComment(issue, `${parts[i]}\n\n${marker(hash, part)}`));
		first ??= id;
	}

	return first;
}

async function ensureLabels(labels: string[], app: App): Promise<void> {
	for (const label of labels) {
		await app.github.ensureLabel(label);
	}
}

async function openIssue(mail: ParsedMail, job: InboundJob, pending: MessageRow | null, unthreaded: boolean, hash: string, app: App): Promise<void> {
	const { cfg, github, store } = app;
	const rendered = renderMail(mail, job.r2Key, false, cfg);
	await storeAttachments(mail, rendered.toStore, job.r2Key, app);

	let issue = pending?.issue_number ?? null;
	if (null === issue && null !== pending) {
		// An earlier attempt may have created the issue without recording it
		issue = (await github.listRecentIssues()).find((candidate) => candidate.body.includes(marker(hash, 0)))?.number ?? null;
	}
	if (null === issue) {
		const labels = [...cfg.labelsNew];
		if (unthreaded) {
			labels.push(cfg.labelUnthreaded);
		}
		if (!mail.automatic && "" !== statusLabel("to_acknowledge", app)) {
			labels.push(statusLabel("to_acknowledge", app));
		}
		await ensureLabels(labels, app);
		issue = await github.createIssue(rendered.title, `${rendered.parts[0]}\n\n${marker(hash, 0)}`, labels, cfg.issueType || undefined);
	}
	await store.updateInbound(mail.messageId, { issueNumber: issue });

	const posted = null === pending ? new Map<number, number>() : await postedParts(issue, hash, pending.created_at, app);
	await postComments(issue, rendered.parts.slice(1), 1, hash, posted, app);

	await store.createThread({
		issueNumber: issue,
		rootMessageId: mail.messageId,
		subject: "(no subject)" === rendered.title ? "" : rendered.title,
		reporter: mail.sender,
		extraRecipients: othersIn(mail, app, mail.sender.address),
	}, app.now().toISOString());
}

async function addComment(mail: ParsedMail, job: InboundJob, pending: MessageRow | null, thread: Thread, hash: string, app: App): Promise<void> {
	const { cfg, github, store } = app;
	const issue = thread.issueNumber;
	const fromReporter = thread.reporter.address === mail.sender.address;
	const fromKnown = fromReporter || thread.extraRecipients.some((known) => known.address === mail.sender.address);

	const rendered = renderMail(mail, job.r2Key, true, cfg);
	await storeAttachments(mail, rendered.toStore, job.r2Key, app);

	const posted = null === pending ? new Map<number, number>() : await postedParts(issue, hash, pending.created_at, app);
	const commentId = await postComments(issue, rendered.parts, 0, hash, posted, app);
	await store.updateInbound(mail.messageId, { commentId, fromReporter });

	if (fromKnown && !mail.automatic) {
		// Until something was sent to them, the reporter is still waiting for an acknowledgment
		await setReportStatus(issue, (await store.hasOutbound(issue)) ? "to_reply" : "to_acknowledge", app);
		if (null !== thread.closedAt && cfg.reopenOnReporterMessage) {
			await github.setIssueState(issue, "open");
			await store.setClosed(issue, null);
		}
	}

	const extra = fromReporter
		? uniqueAddresses([...thread.extraRecipients, ...othersIn(mail, app, thread.reporter.address)])
		: thread.extraRecipients;
	await store.addToThread(thread, mail.messageId, fromReporter, extra);
}

export async function processInbound(job: InboundJob, attempts: number, app: App): Promise<JobResult> {
	const { cfg, store } = app;
	const object = await app.raw.get(job.r2Key);
	if (null === object) {
		app.log("inbound_skipped", { key: await ref(job.r2Key), reason: "raw_missing" });

		return ACK;
	}
	const mail = await parseMail(await object.arrayBuffer(), cfg);
	const id = await ref(mail.messageId);

	const echoOf = await verifyEchoHeader(mail.echo, cfg.hmacSecret);
	if (null !== echoOf) {
		// Our own email, coming back through the list
		const sent = await store.getOutbound(echoOf);
		if (null !== sent && null === sent.message_id) {
			await store.setOutboundStatus(echoOf, "done", mail.messageId);
		}
		app.log("inbound_skipped", { id, reason: "echo" });

		return ACK;
	}

	const pending = await store.getMessage(mail.messageId);
	if (null !== pending && ("done" === pending.status || "out" === pending.direction)) {
		app.log("inbound_skipped", { id, reason: "duplicate" });

		return ACK;
	}

	const references = [...mail.inReplyTo, ...[...mail.references].reverse()];
	const issue = pending?.issue_number ?? (await store.findIssue(references));
	const thread = null === issue ? null : await store.getThread(issue);
	const isRoot = null === thread || thread.rootMessageId === mail.messageId;

	if (null !== issue && null === thread && null === pending) {
		// The parent is known but its thread isn't recorded yet: its own job is being retried
		return retryIn(backoff(attempts));
	}
	if (null === issue && references.length > 0 && null === pending && attempts <= PARENT_RETRIES) {
		// The parent may still be queued
		return retryIn(PARENT_DELAY * attempts);
	}
	if (null !== thread && thread.spam) {
		await store.claimInbound(mail.messageId, thread.issueNumber, job.r2Key, false, app.now().toISOString());
		await store.updateInbound(mail.messageId, { status: "done" });
		app.log("inbound_skipped", { id, reason: "spam_thread" });

		return ACK;
	}

	const hash = await hashId(mail.messageId);
	if (null === pending) {
		// Claim the message before any write to GitHub, so that a retry can tell what happened
		await store.claimInbound(mail.messageId, isRoot ? null : issue, job.r2Key, isRoot || thread.reporter.address === mail.sender.address, app.now().toISOString());
	}

	if (isRoot) {
		await openIssue(mail, job, pending, null === issue && references.length > 0, hash, app);
	} else {
		await addComment(mail, job, pending, thread, hash, app);
	}
	await store.updateInbound(mail.messageId, { status: "done" });
	app.log("inbound_mirrored", { id, new_issue: isRoot, resumed: null !== pending });

	return ACK;
}
