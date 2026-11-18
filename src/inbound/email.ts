import { normalizeAddress, parseAddressList } from "../addresses";
import { type App, ref } from "../app";
import { timingSafeEqual } from "../crypto";
import { extractMessageIds } from "./parse";

type Decision = { accept: true; direct: boolean } | { accept: false; reason: string };

// What the handler needs from a ForwardableEmailMessage.
export interface IncomingMessage {
	readonly from: string;
	readonly to: string;
	readonly headers: Headers;
	readonly raw: ReadableStream<Uint8Array>;
	readonly rawSize: number;
	setReject(reason: string): void;
	forward(rcptTo: string, headers?: Headers): Promise<unknown>;
}

async function throughList(message: IncomingMessage, app: App): Promise<boolean> {
	const { cfg } = app;
	if ("list-headers" === cfg.acceptMode) {
		const listId = (message.headers.get("list-id") ?? "").toLowerCase();

		return null !== cfg.bouncePattern && cfg.bouncePattern.test(message.from) && "" !== cfg.listId && listId.includes(`<${cfg.listId}>`);
	}

	// The inbound address is the secret that proves the message came through the list
	if ("" === cfg.inboundAddress || !(await timingSafeEqual(normalizeAddress(message.to), cfg.inboundAddress))) {
		return false;
	}

	return cfg.headerChecks.every((check) => check.pattern.test(message.headers.get(check.name) ?? ""));
}

// A reply sent straight to our public address, by a client that ignored Reply-To.
async function directReply(message: IncomingMessage, app: App): Promise<boolean> {
	if (normalizeAddress(message.to) !== app.cfg.senderAddress) {
		return false;
	}
	const ids = [...extractMessageIds(message.headers.get("in-reply-to")), ...extractMessageIds(message.headers.get("references")).reverse()];
	const issue = await app.store.findOutboundIssue(ids);
	if (null === issue) {
		return false;
	}
	const thread = await app.store.getThread(issue);
	const from = parseAddressList(message.headers.get("from"))[0]?.address;

	return null !== thread && undefined !== from && [thread.reporter, ...thread.extraRecipients].some((known) => known.address === from);
}

async function decide(message: IncomingMessage, app: App): Promise<Decision> {
	if (await throughList(message, app)) {
		return { accept: true, direct: false };
	}
	if (await directReply(message, app)) {
		return { accept: true, direct: true };
	}

	return { accept: false, reason: "not_accepted" };
}

function rawKey(app: App, prefix: string): string {
	const now = app.now();

	return `${prefix}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${crypto.randomUUID()}.eml`;
}

export async function handleEmail(message: IncomingMessage, app: App): Promise<void> {
	const { cfg } = app;

	if (cfg.observe) {
		// Store everything and do nothing else, to see what the list really delivers
		const key = rawKey(app, "observe");
		await app.raw.put(key, await new Response(message.raw).arrayBuffer(), { customMetadata: { envelopeFrom: message.from, envelopeTo: message.to } });
		app.log("observed", { key: await ref(key) });

		return;
	}

	const decision = await decide(message, app);
	if (!decision.accept) {
		message.setReject("This address does not accept this message");
		app.log("rejected", { reason: decision.reason });

		return;
	}

	// A failure here must fail the delivery, so that the sending server retries
	const key = rawKey(app, "raw");
	await app.raw.put(key, await new Response(message.raw).arrayBuffer(), { customMetadata: { envelopeFrom: message.from } });
	await app.inboundQueue.send({ type: "email", r2Key: key });
	app.log("accepted", { key: await ref(key), direct: decision.direct });

	if (decision.direct && cfg.forwardDirectReplies) {
		try {
			await message.forward(cfg.listAddress);
		} catch {
			app.log("forward_failed", { key: await ref(key) });
		}
	}
}
