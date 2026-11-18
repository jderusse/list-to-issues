import type { App } from "./app";
import { base64UrlDecode, base64UrlEncode, hmacHex, timingSafeEqual } from "./crypto";

interface TokenPayload {
	// R2 key
	k: string;
	// Expiry, in seconds since the epoch
	e: number;
	// File name offered to the browser
	n: string;
}

// A token names one R2 object and expires. There is no way to list anything with it.
export async function createDownloadUrl(base: string, key: string, filename: string, app: App): Promise<string> {
	const payload: TokenPayload = { k: key, e: Math.floor(app.now().getTime() / 1000) + app.cfg.downloadLinkTtl, n: filename };
	const encoded = base64UrlEncode(JSON.stringify(payload));

	return `${base}/download/${encoded}.${await hmacHex(app.cfg.hmacSecret, `download:${encoded}`)}`;
}

async function verifyToken(token: string, app: App): Promise<TokenPayload | null> {
	const [encoded = "", signature = "", ...extra] = token.split(".");
	if (extra.length > 0 || !(await timingSafeEqual(signature, await hmacHex(app.cfg.hmacSecret, `download:${encoded}`)))) {
		return null;
	}
	const bytes = base64UrlDecode(encoded);
	if (null === bytes) {
		return null;
	}
	try {
		const payload = JSON.parse(new TextDecoder().decode(bytes)) as TokenPayload;
		if ("string" !== typeof payload.k || "number" !== typeof payload.e || "string" !== typeof payload.n) {
			return null;
		}

		return payload.e >= Math.floor(app.now().getTime() / 1000) ? payload : null;
	} catch {
		return null;
	}
}

function contentDisposition(filename: string): string {
	const clean = filename.replace(/[\u0000-\u001f\u007f"\\/]+/g, "_").slice(0, 200) || "download";
	const ascii = clean.replace(/[^\x20-\x7e]/g, "_");

	return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean)}`;
}

export async function handleDownload(request: Request, token: string, app: App): Promise<Response> {
	if ("GET" !== request.method && "HEAD" !== request.method) {
		return new Response("Method not allowed", { status: 405 });
	}
	const payload = await verifyToken(token, app);
	if (null === payload) {
		return new Response("This link is invalid or expired", { status: 403 });
	}
	const object = await app.raw.get(payload.k);
	if (null === object) {
		return new Response("This file no longer exists", { status: 404 });
	}

	// Always a download, never something that a browser renders
	return new Response("HEAD" === request.method ? null : object.body, {
		headers: {
			"content-type": "application/octet-stream",
			"content-disposition": contentDisposition(payload.n),
			"content-length": String(object.size),
			"x-content-type-options": "nosniff",
			"cache-control": "private, no-store",
			"referrer-policy": "no-referrer",
		},
	});
}
