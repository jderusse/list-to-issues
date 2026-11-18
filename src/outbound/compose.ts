import { type Address, sanitizeDisplayName, sanitizeHeaderValue, uniqueAddresses } from "../addresses";
import type { OutgoingEmail } from "../app";
import type { Config } from "../config";
import { echoHeader } from "../echo";
import type { Upload } from "../github/types";
import { ECHO_HEADER } from "../inbound/parse";
import { escapeHtml } from "../markdown";
import type { Thread } from "../store";

export interface Quote {
	date: string;
	name: string;
	text: string;
}

export interface ComposeInput {
	thread: Thread;
	commentId: number;
	commenter: string;
	markdown: string;
	html: string;
	quote: Quote | null;
	attachments: Upload[];
}

// The email service caps a header value at 2,048 bytes.
const REFERENCES_BYTES = 1800;

export function fill(template: string, commenter: string, cfg: Config): string {
	return template.replaceAll("{commenter}", commenter).replaceAll("{label}", cfg.senderLabel);
}

function references(thread: Thread): string {
	const root = `<${thread.rootMessageId}>`;
	const rest: string[] = [];
	let size = root.length;
	for (const id of [...thread.refs].reverse()) {
		size += id.length + 3;
		if (size > REFERENCES_BYTES) {
			break;
		}
		rest.unshift(`<${id}>`);
	}

	return [root, ...rest].join(" ");
}

function quoteDate(date: string): string {
	const parsed = new Date(date);

	return Number.isNaN(parsed.getTime()) ? sanitizeHeaderValue(date, 80) : parsed.toUTCString().replace("GMT", "UTC");
}

// Whether a text points to the repository, which the recipient of an email can't open.
export function linksToRepository(text: string, cfg: Config): boolean {
	const repo = `${cfg.repoOwner}/${cfg.repoName}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

	return new RegExp(`github\\.com/${repo}(?![\\w.-])|(^|[^\\w./-])${repo}#\\d`, "i").test(text);
}

export async function compose(input: ComposeInput, cfg: Config): Promise<OutgoingEmail> {
	const { thread } = input;
	const cc: Address[] = cfg.ccExtraRecipients ? [...thread.extraRecipients] : [];
	if (cfg.ccList) {
		cc.push({ address: cfg.listAddress, name: "" });
	}

	let text = input.markdown.trim();
	let html = `<div>${input.html}</div>`;
	if (null !== input.quote && "" !== input.quote.text) {
		const intro = `On ${quoteDate(input.quote.date)}, ${sanitizeHeaderValue(input.quote.name, 120)} wrote:`;
		text += `\n\n${intro}\n${input.quote.text.split("\n").map((line) => `> ${line}`.trimEnd()).join("\n")}`;
		html += `<p>${escapeHtml(intro)}</p><blockquote>${escapeHtml(input.quote.text).replace(/\n/g, "<br>\n")}</blockquote>`;
	}
	const signature = fill(cfg.signature, input.commenter, cfg).trim();
	if ("" !== signature) {
		text += `\n\n-- \n${signature}`;
		html += `<p>-- <br>\n${escapeHtml(signature).replace(/\n/g, "<br>\n")}</p>`;
	}

	return {
		to: thread.reporter,
		cc: uniqueAddresses(cc, [thread.reporter.address, cfg.senderAddress, cfg.inboundAddress]),
		from: { address: cfg.senderAddress, name: sanitizeDisplayName(fill(cfg.senderNameTemplate, input.commenter, cfg)) },
		replyTo: cfg.listAddress,
		subject: sanitizeHeaderValue(`Re: ${thread.subject || "(no subject)"}`),
		text,
		html,
		headers: {
			"In-Reply-To": `<${thread.lastReporterMessageId ?? thread.rootMessageId}>`,
			References: references(thread),
			[ECHO_HEADER.replace(/(^|-)([a-z])/g, (_match, dash: string, letter: string) => dash + letter.toUpperCase())]: await echoHeader(input.commentId, cfg.hmacSecret),
		},
		attachments: input.attachments.map((upload) => ({ filename: upload.filename, type: upload.contentType, content: upload.content })),
	};
}
