import { type GitHub, GitHubError, type Upload } from "../github/types";

// Files dropped into a comment are stored behind GitHub's authentication.
const UPLOAD_URL = /https:\/\/github\.com\/(?:user-attachments\/(?:assets|files)\/[^\s)"'<>\]]+|[\w.-]+\/[\w.-]+\/(?:files|assets)\/[^\s)"'<>\]]+)/g;

const MAX_UPLOADS = 20;
const MAX_BYTES = 20 * 1024 * 1024;

export class UploadError extends Error {}

function safeName(name: string, fallback: string): string {
	return name.replace(/[\u0000-\u001f\u007f"\\/<>:|?*]+/g, "_").trim().slice(0, 200) || fallback;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Fetches the files that a comment links to and replaces their links by their names,
// since the recipient of the email can't open the links.
export async function attachUploads(markdown: string, github: GitHub): Promise<{ markdown: string; attachments: Upload[] }> {
	const urls = [...new Set(markdown.match(UPLOAD_URL) ?? [])];
	if (urls.length > MAX_UPLOADS) {
		throw new UploadError("too_many_files");
	}

	const attachments: Upload[] = [];
	let total = 0;
	for (const [index, url] of urls.entries()) {
		let upload: Upload;
		try {
			upload = await github.fetchUpload(url);
		} catch (error) {
			if (error instanceof GitHubError && error.transient) {
				throw error;
			}
			throw new UploadError("file_unavailable");
		}
		total += upload.content.byteLength;
		if (total > MAX_BYTES) {
			throw new UploadError("files_too_large");
		}

		const target = escapeRegExp(url);
		const label = new RegExp(`!?\\[([^\\]]*)\\]\\(${target}\\)`).exec(markdown)?.[1] ?? "";
		let name = safeName(upload.filename || label, `file-${index + 1}`);
		if (attachments.some((other) => other.filename === name)) {
			name = `${index + 1}-${name}`;
		}
		attachments.push({ ...upload, filename: name });

		markdown = markdown
			.replace(new RegExp(`!\\[[^\\]]*\\]\\(${target}\\)`, "g"), `[image: ${name}]`)
			.replace(new RegExp(`\\[[^\\]]*\\]\\(${target}\\)`, "g"), `${name} (attached)`)
			.replace(new RegExp(`<img\\b[^>]*\\bsrc=["']${target}["'][^>]*>`, "gi"), `[image: ${name}]`)
			.replace(new RegExp(target, "g"), `${name} (attached)`);
	}

	return { markdown, attachments };
}
