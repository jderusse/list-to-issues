import { ConfigError } from "../config";
import { base64Decode, base64UrlEncode } from "../crypto";

// GitHub hands out PKCS#1 keys, WebCrypto only imports PKCS#8:
//   openssl pkcs8 -topk8 -nocrypt -in app.private-key.pem -out app.pkcs8.pem
export async function importPrivateKey(pem: string): Promise<CryptoKey> {
	if (pem.includes("BEGIN RSA PRIVATE KEY")) {
		throw new ConfigError("The private key is in the PKCS#1 format: convert it with `openssl pkcs8 -topk8 -nocrypt`");
	}
	const der = base64Decode(pem.replace(/\\n/g, "\n").replace(/-----[^-]+-----/g, ""));

	return crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

// The JWT that authenticates the GitHub App itself, valid for a few minutes.
export async function createAppJwt(appId: string, key: CryptoKey, now: Date): Promise<string> {
	const seconds = Math.floor(now.getTime() / 1000);
	const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
	const payload = base64UrlEncode(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: appId }));
	const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${payload}`));

	return `${header}.${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}
