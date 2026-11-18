import type { Config } from "../config";
import { details, escapeForHtml, escapeMarkdown, fence, formatSize } from "../markdown";
import { cleanSubject, stripFooter, stripQuotedReply } from "./body";
import type { MailAttachment, ParsedMail } from "./parse";

// GitHub caps issue and comment bodies at 65,536 characters. Keep room for the marker.
export const PART_LIMIT = 60000;

const TEXT_TYPE = /^(text\/|message\/|application\/(json|xml|yaml|x-yaml|toml|sql|javascript|x-javascript|ecmascript|x-sh|x-shellscript|x-csh|x-php|x-httpd-php|x-python|x-perl|x-ruby|x-patch|x-diff|x-pem-file|x-x509-ca-cert|pgp-signature|pgp-keys|pgp-encrypted|x-ndjson|graphql|x-www-form-urlencoded)\b)|\+(json|xml|yaml)$/;

const LANGUAGES: Record<string, string> = {
	php: "php", phtml: "php", js: "js", mjs: "js", cjs: "js", ts: "ts", jsx: "jsx", tsx: "tsx", py: "python", rb: "ruby",
	sh: "sh", bash: "sh", zsh: "sh", json: "json", xml: "xml", html: "html", htm: "html", svg: "xml", css: "css",
	yml: "yaml", yaml: "yaml", toml: "toml", ini: "ini", sql: "sql", md: "markdown", diff: "diff", patch: "diff",
	c: "c", h: "c", cpp: "cpp", cc: "cpp", java: "java", go: "go", rs: "rust", pl: "perl", twig: "twig", http: "http",
};

export interface Rendered {
	title: string;
	parts: string[];
	// Indexes of the attachments that the comments don't show in full: they go to R2
	toStore: number[];
}

function decodeText(attachment: MailAttachment): string | null {
	const declared = TEXT_TYPE.test(attachment.mimeType);
	try {
		const text = new TextDecoder("utf-8", { fatal: !declared, ignoreBOM: false }).decode(attachment.content);

		return text.includes("\u0000") ? null : text;
	} catch {
		return null;
	}
}

function language(filename: string): string {
	return LANGUAGES[/\.([A-Za-z0-9]+)$/.exec(filename)?.[1]?.toLowerCase() ?? ""] ?? "";
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function displayName(attachment: MailAttachment, index: number): string {
	return oneLine(attachment.filename).slice(0, 200) || `attachment-${index + 1}`;
}

// The facts about a message, as a YAML block that people can read and tools can parse.
// Every value is a JSON string, which is also a YAML string, inside a code fence.
function headerBlock(mail: ParsedMail, r2Key: string): string {
	const lines = [
		"from:",
		`  name: ${JSON.stringify(oneLine(mail.sender.name))}`,
		`  email: ${JSON.stringify(mail.sender.address)}`,
		`date: ${JSON.stringify(oneLine(mail.date))}`,
		`message_id: ${JSON.stringify(mail.messageId)}`,
		`raw_message: ${JSON.stringify(r2Key)}`,
	];
	const notes: string[] = [];
	if (null === mail.auth) {
		lines.push("authentication: null");
		notes.push("> :warning: The receiving server gave no authentication result for this message.");
	} else {
		lines.push("authentication:", `  spf: ${JSON.stringify(mail.auth.spf)}`, `  dkim: ${JSON.stringify(mail.auth.dkim)}`, `  dmarc: ${JSON.stringify(mail.auth.dmarc)}`);
		if ("pass" !== mail.auth.dmarc) {
			// Replies go to the address of the sender, so this must be visible
			notes.push(`> :warning: The sender of this message is not authenticated (DMARC ${mail.auth.dmarc}).`);
		}
	}
	if (mail.automatic) {
		lines.push("automatic: true");
		notes.push("> Automatic message.");
	}

	return [fence(lines.join("\n"), "yaml"), ...(notes.length > 0 ? [notes.join("\n")] : [])].join("\n\n");
}

function textBlock(name: string, size: number, content: string, lang: string, note = ""): string {
	return details(`${escapeForHtml(name)} (${formatSize(size)})`, fence(content, lang) + note);
}

// Shortens the source until what it renders to fits, so that an escape sequence is never cut.
function fit(source: string, limit: number, render: (text: string) => string): string {
	let length = source.length;
	let rendered = render(source);
	while (rendered.length > limit && length > 0) {
		length = Math.max(0, Math.min(length - 1, Math.floor(length * (limit / rendered.length) * 0.95)));
		rendered = render(source.slice(0, length));
	}

	return rendered;
}

export function renderMail(mail: ParsedMail, r2Key: string, isReply: boolean, cfg: Config): Rendered {
	const full = mail.text;
	let visible = stripFooter(full, cfg.footerPattern);
	if (isReply) {
		visible = stripQuotedReply(visible);
	}
	visible = visible.trim();

	const toStore: number[] = [];
	const blocks: { index: number; name: string; size: number; content: string; lang: string }[] = [];
	const hidden: string[] = [];
	mail.attachments.forEach((attachment, index) => {
		const name = displayName(attachment, index);
		const size = attachment.content.byteLength;
		const text = size > 0 && size <= cfg.attachmentMaxBytes && !attachment.mimeType.startsWith("image/") ? decodeText(attachment) : null;
		if (null === text) {
			toStore.push(index);
			hidden.push(`- ${escapeMarkdown(name)} (${escapeMarkdown(oneLine(attachment.mimeType).slice(0, 80))}, ${formatSize(size)})`);
		} else {
			blocks.push({ index, name, size, content: text, lang: language(name) });
		}
	});

	const head = headerBlock(mail, r2Key);
	const truncatedNote = "\n\n_Truncated: `/attachments` gives the raw message._";
	let first = `${head}\n\n${"" === visible ? "_(no text)_" : escapeMarkdown(visible)}`;
	if (first.length > PART_LIMIT) {
		first = fit(visible, PART_LIMIT - head.length - truncatedNote.length - 2, escapeMarkdown);
		first = `${head}\n\n${first}${truncatedNote}`;
	}

	const parts: string[] = [first];
	const append = (section: string, continued: string): void => {
		const current = parts[parts.length - 1]!;
		if (current.length + section.length + 2 <= PART_LIMIT) {
			parts[parts.length - 1] = `${current}\n\n${section}`;
		} else {
			parts.push(`${continued}\n\n${section}`);
		}
	};

	if (visible !== full.trim()) {
		const section = details("Full message text", fence(full));
		if (first.length + section.length + 2 <= PART_LIMIT) {
			parts[0] = `${first}\n\n${section}`;
		}
	}
	if (hidden.length > 0) {
		const list = hidden.slice(0, 100);
		if (hidden.length > list.length) {
			list.push(`- and ${hidden.length - list.length} more`);
		}
		append(`**Attachments not shown** (\`/attachments\` gives download links):\n${list.join("\n")}`, "_Attachments of the message above._");
	}

	const continued = "_Attachments of the message above, continued._";
	const room = PART_LIMIT - continued.length - 2;
	for (const block of blocks) {
		let section = textBlock(block.name, block.size, block.content, block.lang);
		if (section.length > room) {
			const note = "\n\n_Truncated: `/attachments` gives the full file._";
			section = fit(block.content, room, (content) => textBlock(block.name, block.size, content, block.lang, note));
			toStore.push(block.index);
		}
		append(section, continued);
	}

	return { title: cleanSubject(mail.subject, cfg.subjectTag) || "(no subject)", parts, toStore: toStore.sort((a, b) => a - b) };
}

// What a reply quotes: the text of the message without its own quoted history and footer.
export function quotableText(mail: ParsedMail, cfg: Config): string {
	return stripQuotedReply(stripFooter(mail.text, cfg.footerPattern)).trim();
}
