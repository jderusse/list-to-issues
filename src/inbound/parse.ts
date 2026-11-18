import PostalMime from "postal-mime";
import type { Email, Header } from "postal-mime";
import { type Address, domainOf, parseAddressList, sanitizeDisplayName, toAddresses } from "../addresses";
import type { Config } from "../config";
import { sha256Hex } from "../crypto";
import { normalizeNewlines } from "../markdown";
import { htmlToText } from "./body";

export const ECHO_HEADER = "x-list-to-issues";

export interface MailAttachment {
	filename: string;
	mimeType: string;
	content: Uint8Array;
	inline: boolean;
}

export interface AuthResults {
	spf: string;
	dkim: string;
	dmarc: string;
}

export interface ParsedMail {
	messageId: string;
	inReplyTo: string[];
	references: string[];
	subject: string;
	date: string;
	sender: Address;
	recipients: Address[];
	text: string;
	automatic: boolean;
	auth: AuthResults | null;
	echo: string | null;
	attachments: MailAttachment[];
}

export function extractMessageIds(value: string | null | undefined): string[] {
	if (!value) {
		return [];
	}
	const ids = [...value.matchAll(/<([^<>\s]+)>/g)].map((match) => match[1]!);
	if (0 === ids.length && /^\S+@\S+$/.test(value.trim())) {
		ids.push(value.trim());
	}

	return ids.slice(-50);
}

function header(headers: Header[], name: string): string | null {
	return headers.find((entry) => entry.key === name)?.value ?? null;
}

// Only the header that Cloudflare prepended can be trusted: it comes first and names
// mx.cloudflare.net. Any other one was supplied by the sender.
function authResults(headers: Header[]): AuthResults | null {
	const first = headers.find((entry) => "authentication-results" === entry.key);
	if (!first || !/^\s*mx\.cloudflare\.net\s*;/i.test(first.value)) {
		return null;
	}
	const result = (method: string): string => new RegExp(`\\b${method}=([a-z]+)`, "i").exec(first.value)?.[1]?.toLowerCase() ?? "none";

	return { spf: result("spf"), dkim: result("dkim"), dmarc: result("dmarc") };
}

function isAutomatic(headers: Header[]): boolean {
	const autoSubmitted = header(headers, "auto-submitted")?.trim().toLowerCase();
	if (autoSubmitted && "no" !== autoSubmitted) {
		return true;
	}
	if (/^(bulk|junk|auto_reply)\b/i.test(header(headers, "precedence")?.trim() ?? "")) {
		return true;
	}

	// X-Auto-Response-Suppress is not a sign: it asks for no auto-reply, and some list
	// servers add it to every message they relay.
	return ["x-autoreply", "x-autorespond"].some((name) => null !== header(headers, name));
}

// Lists that rewrite From to pass DMARC keep the author elsewhere.
function recoverSender(mail: Email, cfg: Config): Address {
	const from = toAddresses(mail.from ? [mail.from] : [])[0] ?? { address: "", name: "" };
	const rewritten = from.address === cfg.listAddress
		|| ("" !== from.address && domainOf(from.address) === domainOf(cfg.listAddress) && /\svia\s/i.test(from.name));
	if (!rewritten && "" !== from.address) {
		return from;
	}

	const notList = (candidate: Address): boolean => candidate.address !== cfg.listAddress;
	const original = parseAddressList(header(mail.headers, "x-original-from")).find(notList)
		?? toAddresses(mail.replyTo).find(notList)
		?? toAddresses(mail.cc).find(notList);
	if (!original) {
		return from;
	}

	return { address: original.address, name: original.name || sanitizeDisplayName(from.name.replace(/\s+via\s.*$/i, "")) };
}

export async function parseMail(raw: ArrayBuffer, cfg: Config): Promise<ParsedMail> {
	const mail = await PostalMime.parse(raw);
	const text = undefined !== mail.text && "" !== mail.text.trim() ? mail.text : htmlToText(mail.html ?? "");

	return {
		messageId: extractMessageIds(mail.messageId)[0] ?? `${(await sha256Hex(raw)).slice(0, 40)}@synthetic.invalid`,
		inReplyTo: extractMessageIds(mail.inReplyTo),
		references: extractMessageIds(mail.references),
		subject: mail.subject ?? "",
		date: mail.date ?? "",
		sender: recoverSender(mail, cfg),
		recipients: [...toAddresses(mail.to), ...toAddresses(mail.cc)],
		text: normalizeNewlines(text).trim(),
		automatic: isAutomatic(mail.headers),
		auth: authResults(mail.headers),
		echo: header(mail.headers, ECHO_HEADER)?.trim() ?? null,
		attachments: mail.attachments.map((attachment) => ({
			filename: attachment.filename ?? "",
			mimeType: attachment.mimeType || "application/octet-stream",
			content: "string" === typeof attachment.content
				? new TextEncoder().encode(attachment.content)
				: attachment.content instanceof Uint8Array ? attachment.content : new Uint8Array(attachment.content),
			inline: true === attachment.related || "inline" === attachment.disposition,
		})),
	};
}
