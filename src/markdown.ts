// Email content is untrusted. These helpers render it on GitHub so that it can neither
// ping people nor break out of the structure of the comment.

const ZWSP = "\u200b";

export function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// GitHub links "@name" and "#123" after rendering, so a backslash doesn't stop it.
// A zero-width space after the sign does.
export function neutralizeReferences(text: string): string {
	return text.replace(/(^|[^A-Za-z0-9_/])@(?=[A-Za-z0-9])/g, `$1@${ZWSP}`).replace(/#(?=\d)/g, `#${ZWSP}`);
}

const URL = /\bhttps?:\/\/[^\s<>`"]+/g;

function escapeSegment(text: string): string {
	return neutralizeReferences(
		text
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/([\\`*_[\]#~|])/g, "\\$1"),
	);
}

function escapeLine(line: string): string {
	let lead = "";
	const indent = /^[ \t]+/.exec(line);
	if (indent) {
		// Four leading spaces would start a code block
		lead = indent[0].replace(/\t/g, "    ").replace(/ /g, "&nbsp;");
		line = line.slice(indent[0].length);
	}

	let escaped = "";
	let last = 0;
	for (const match of line.matchAll(URL)) {
		// A backslash inside a bare URL would end up in the link, so URLs are only HTML-escaped
		escaped += escapeSegment(line.slice(last, match.index)) + match[0].replace(/&/g, "&amp;");
		last = match.index + match[0].length;
	}
	escaped += escapeSegment(line.slice(last));

	// Constructs that only matter at the start of a line: lists, setext underlines, rules
	escaped = escaped.replace(/^(\d+)([.)])/, "$1\\$2").replace(/^([-+=])/, "\\$1");

	return lead + escaped;
}

// Renders plain text literally: nothing in it is interpreted as markdown or HTML.
export function escapeMarkdown(text: string): string {
	return normalizeNewlines(text).split("\n").map(escapeLine).join("\n");
}

export function normalizeNewlines(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}

// A fenced block whose fence is longer than any run of backticks in the content.
export function fence(content: string, language = ""): string {
	let longest = 0;
	for (const run of content.matchAll(/`+/g)) {
		longest = Math.max(longest, run[0].length);
	}
	const marker = "`".repeat(Math.max(3, longest + 1));
	const body = normalizeNewlines(content).replace(/\n+$/, "");

	return `${marker}${language.replace(/[^A-Za-z0-9+#-]/g, "")}\n${body}\n${marker}`;
}

// Text for a <summary> or another HTML context.
export function escapeForHtml(text: string): string {
	return neutralizeReferences(escapeHtml(text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").trim()));
}

export function details(summary: string, content: string): string {
	return `<details>\n<summary>${summary}</summary>\n\n${content}\n\n</details>`;
}

export function formatSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} KB`;
	}

	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
