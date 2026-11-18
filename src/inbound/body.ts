import { normalizeNewlines } from "../markdown";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
		if ("#" === code[0]) {
			const point = "x" === code[1]?.toLowerCase() ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);

			return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
		}

		return ENTITIES[code.toLowerCase()] ?? match;
	});
}

// A plain conversion: good enough to read an HTML-only message, not a renderer.
export function htmlToText(html: string): string {
	let text = html
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, "")
		.replace(/<a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a\s*>/gi, (_match, _quoted, double, single, label: string) => {
			const href = String(double ?? single ?? "");
			const inner = label.replace(/<[^>]+>/g, "").trim();

			return "" === inner || inner === href || !/^https?:/i.test(href) ? inner || href : `${inner} (${href})`;
		})
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<li\b[^>]*>/gi, "\n- ")
		.replace(/<\/(p|div|tr|table|h[1-6]|blockquote|pre|ul|ol)\s*>/gi, "\n\n")
		.replace(/<\/(td|th)\s*>/gi, "\t")
		.replace(/<[^>]+>/g, "");
	text = decodeEntities(text);

	return normalizeNewlines(text)
		.split("\n")
		.map((line) => line.replace(/[ \t\u00a0]+$/g, "").replace(/^[ \t\u00a0]+(?=\S)/, (indent) => (indent.length > 8 ? "" : indent)))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

const QUOTE_INTRO = [
	/^On\b.{1,300}\bwrote:$/i,
	/^Le\b.{1,300}\ba écrit\s*:$/i,
	/^Am\b.{1,300}\bschrieb\b.{0,100}:$/i,
	/^El\b.{1,300}\bescribió\s*:$/i,
	/^-{2,}\s*Original Message\s*-{2,}$/i,
	/^-{2,}\s*Message d'origine\s*-{2,}$/i,
	/^-{2,}\s*Ursprüngliche Nachricht\s*-{2,}$/i,
];

function isQuoteIntro(lines: string[], index: number): boolean {
	const line = lines[index]!.trim();
	if ("" === line) {
		return false;
	}
	if (QUOTE_INTRO.some((pattern) => pattern.test(line))) {
		return true;
	}
	// "On <date>, <name>" wrapped on two lines by the mail client
	const next = lines[index + 1]?.trim() ?? "";
	if ("" !== next && QUOTE_INTRO.some((pattern) => pattern.test(`${line} ${next}`)) && /^(On|Le|Am|El)\b/i.test(line)) {
		return true;
	}
	// The header block that some clients put above the quoted message
	if (/^(From|De|Von)\s*:\s*\S/i.test(line)) {
		const block = lines.slice(index + 1, index + 6).join("\n");

		return /^(Sent|Date|Envoyé|Gesendet)\s*:/im.test(block) && /^(Subject|Objet|Betreff|To|À|An)\s*:/im.test(block);
	}

	return false;
}

function hasContent(lines: string[]): boolean {
	return lines.some((line) => "" !== line.trim() && !line.trimStart().startsWith(">"));
}

// Removes the quoted history that a reply carries below its own text.
export function stripQuotedReply(text: string): string {
	const lines = normalizeNewlines(text).split("\n");

	for (let i = 1; i < lines.length; i++) {
		if (isQuoteIntro(lines, i) && hasContent(lines.slice(0, i))) {
			return lines.slice(0, i).join("\n").trimEnd();
		}
	}

	let end = lines.length;
	while (end > 0 && ("" === lines[end - 1]!.trim() || lines[end - 1]!.trimStart().startsWith(">"))) {
		end--;
	}
	if (end < lines.length && hasContent(lines.slice(0, end)) && lines.slice(end).some((line) => line.trimStart().startsWith(">"))) {
		return lines.slice(0, end).join("\n").trimEnd();
	}

	return text;
}

export function stripFooter(text: string, pattern: RegExp | null): string {
	if (null === pattern) {
		return text;
	}
	const match = pattern.exec(text);

	return null === match ? text : text.slice(0, match.index).trimEnd();
}

const REPLY_PREFIX = /^(re|fwd?|aw|tr|wg|rv|sv|antw)\s*(\[\d+\])?\s*:\s*/i;

export function cleanSubject(subject: string, tag: string): string {
	let cleaned = subject.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").trim();
	for (let previous = ""; previous !== cleaned; ) {
		previous = cleaned;
		if ("" !== tag && cleaned.toLowerCase().startsWith(tag.toLowerCase())) {
			cleaned = cleaned.slice(tag.length).trim();
		}
		cleaned = cleaned.replace(REPLY_PREFIX, "").trim();
	}

	return cleaned.replace(/\s+/g, " ").slice(0, 240);
}
