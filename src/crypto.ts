const encoder = new TextEncoder();

export function toHex(bytes: ArrayBuffer | Uint8Array): string {
	const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let hex = "";
	for (const byte of view) {
		hex += byte.toString(16).padStart(2, "0");
	}

	return hex;
}

export async function sha256Hex(data: string | ArrayBuffer | Uint8Array): Promise<string> {
	return toHex(await crypto.subtle.digest("SHA-256", "string" === typeof data ? encoder.encode(data) : data));
}

// Short and stable, for logs and markers: never log the id itself.
export async function hashId(id: string): Promise<string> {
	return (await sha256Hex(id)).slice(0, 32);
}

export async function hmacHex(secret: string, data: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);

	return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(data)));
}

// Compares two strings in constant time, whatever their lengths: both are hashed first.
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
	const [left, right] = await Promise.all([
		crypto.subtle.digest("SHA-256", encoder.encode(a)),
		crypto.subtle.digest("SHA-256", encoder.encode(b)),
	]);
	const x = new Uint8Array(left);
	const y = new Uint8Array(right);
	let diff = 0;
	for (let i = 0; i < x.length; i++) {
		diff |= x[i]! ^ y[i]!;
	}

	return 0 === diff;
}

export function base64UrlEncode(data: string | Uint8Array): string {
	const bytes = "string" === typeof data ? encoder.encode(data) : data;
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}

	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(value: string): Uint8Array | null {
	if (!/^[A-Za-z0-9_-]*$/.test(value)) {
		return null;
	}
	try {
		const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) {
			bytes[i] = binary.charCodeAt(i);
		}

		return bytes;
	} catch {
		return null;
	}
}

export function base64Decode(value: string): Uint8Array {
	const binary = atob(value.replace(/\s+/g, ""));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}

	return bytes;
}
