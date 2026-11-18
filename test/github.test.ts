import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MailError } from "../src/app";
import { ConfigError, loadConfig } from "../src/config";
import { base64UrlDecode } from "../src/crypto";
import { importPrivateKey } from "../src/github/auth";
import { forgetTokens, GitHubClient } from "../src/github/client";
import { GitHubError } from "../src/github/types";
import { CloudflareMailer } from "../src/mailer";
import { testEnv } from "./helpers";

interface Call {
	method: string;
	url: string;
	headers: Headers;
	body: string;
}

async function keyPair(): Promise<{ pem: string; publicKey: CryptoKey }> {
	const pair = (await crypto.subtle.generateKey(
		{ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
		true,
		["sign", "verify"],
	)) as CryptoKeyPair;
	const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
	const base64 = btoa(String.fromCharCode(...der)).match(/.{1,64}/g)!.join("\n");

	return { pem: `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----\n`, publicKey: pair.publicKey };
}

describe("GitHub App client", () => {
	let calls: Call[];
	let answers: ((call: Call) => Response | undefined)[];
	let now: Date;
	let client: GitHubClient;
	let publicKey: CryptoKey;

	function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
		return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
	}

	beforeEach(async () => {
		forgetTokens();
		calls = [];
		answers = [];
		now = new Date("2026-11-18T10:00:00Z");
		const keys = await keyPair();
		publicKey = keys.publicKey;
		client = new GitHubClient(loadConfig(testEnv({ GITHUB_APP_PRIVATE_KEY: keys.pem })), () => now);

		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const request = new Request(input as RequestInfo, init);
			const call: Call = { method: request.method, url: request.url, headers: request.headers, body: await request.text() };
			calls.push(call);
			if (call.url.endsWith("/app/installations/2/access_tokens")) {
				return json({ token: `token-${calls.length}`, expires_at: new Date(now.getTime() + 3_600_000).toISOString() }, 201);
			}
			for (const answer of answers) {
				const response = answer(call);
				if (response) {
					return response;
				}
			}

			return json({}, 404);
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("authenticates as the App with a signed JWT, then as the installation", async () => {
		answers.push(() => json({ number: 7 }, 201));

		expect(await client.createIssue("Title", "Body", ["via-email"])).toBe(7);

		const [tokenCall, issueCall] = calls;
		const [header, payload, signature] = tokenCall!.headers.get("authorization")!.replace("Bearer ", "").split(".");
		expect(JSON.parse(new TextDecoder().decode(base64UrlDecode(header!)!))).toEqual({ alg: "RS256", typ: "JWT" });
		const claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload!)!));
		expect(claims).toEqual({ iat: now.getTime() / 1000 - 60, exp: now.getTime() / 1000 + 540, iss: "1" });
		expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, base64UrlDecode(signature!)!, new TextEncoder().encode(`${header}.${payload}`))).toBe(true);

		expect(issueCall!.method).toBe("POST");
		expect(issueCall!.url).toBe("https://api.github.com/repos/example-org/example-repo/issues");
		expect(issueCall!.headers.get("authorization")).toBe("Bearer token-1");
		expect(JSON.parse(issueCall!.body)).toEqual({ title: "Title", body: "Body", labels: ["via-email"] });
	});

	it("keeps the installation token until shortly before it expires", async () => {
		answers.push(() => json({ id: 1 }, 201));
		await client.createComment(1, "a");
		await client.createComment(1, "b");
		expect(calls.filter((call) => call.url.includes("access_tokens"))).toHaveLength(1);

		now = new Date(now.getTime() + 3_590_000);
		await client.createComment(1, "c");
		expect(calls.filter((call) => call.url.includes("access_tokens"))).toHaveLength(2);
	});

	it("tells transient failures from permanent ones", async () => {
		const cases: [Response, boolean, number | null][] = [
			[json({}, 503), true, null],
			[json({}, 429, { "retry-after": "17" }), true, 17],
			[json({ message: "You have exceeded a secondary rate limit" }, 403), true, null],
			[json({}, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 30) }), true, expect.any(Number) as unknown as number],
			[json({ message: "Resource not accessible by integration" }, 403), false, null],
			[json({ message: "Validation Failed" }, 422), false, null],
		];
		for (const [response, transient, retryAfter] of cases) {
			answers = [() => response];
			const error = await client.createComment(1, "x").catch((e: unknown) => e);
			expect(error).toBeInstanceOf(GitHubError);
			expect((error as GitHubError).transient).toBe(transient);
			expect((error as GitHubError).retryAfter).toEqual(retryAfter);
		}
	});

	it("asks for a new token after a 401", async () => {
		answers.push((call) => ("Bearer token-1" === call.headers.get("authorization") ? json({}, 401) : json({ id: 5 }, 201)));

		await expect(client.createComment(1, "x")).rejects.toMatchObject({ status: 401, transient: true });
		expect(await client.createComment(1, "x")).toBe(5);
	});

	it("reads a comment, and answers null when it is gone", async () => {
		answers.push((call) => (call.url.endsWith("/issues/comments/10")
			? json({ id: 10, body: "/reply\nHi", issue_url: "https://api.github.com/repos/example-org/example-repo/issues/3", created_at: "2026-11-18T09:00:00Z", user: { login: "someone", type: "User" } })
			: undefined));

		expect(await client.getComment(10)).toEqual({ id: 10, issueNumber: 3, body: "/reply\nHi", login: "someone", isBot: false, createdAt: "2026-11-18T09:00:00Z" });
		expect(await client.getComment(11)).toBeNull();
	});

	it("creates a label once, and accepts that it exists", async () => {
		answers.push(() => json({ message: "Validation Failed" }, 422));
		await client.ensureLabel("via-email");
		await client.ensureLabel("via-email");

		expect(calls.filter((call) => call.url.endsWith("/labels"))).toHaveLength(1);
	});

	it("reads the real permission of a user", async () => {
		answers.push((call) => {
			if (call.url.endsWith("/collaborators/maintainer/permission")) {
				return json({ permission: "write", role_name: "maintain" });
			}
			if (call.url.endsWith("/collaborators/custom/permission")) {
				return json({ permission: "read", role_name: "a-custom-role" });
			}

			return undefined;
		});

		expect(await client.getPermission("maintainer")).toBe("maintain");
		expect(await client.getPermission("custom")).toBe("read");
		expect(await client.getPermission("stranger")).toBe("none");
	});

	it("renders markdown without the repository as context", async () => {
		answers.push(() => new Response("<p>Hello</p>"));

		expect(await client.renderMarkdown("Hello")).toBe("<p>Hello</p>");
		expect(JSON.parse(calls.at(-1)!.body)).toEqual({ text: "Hello", mode: "gfm" });
	});

	it("fetches an uploaded file, and keeps the token on github.com", async () => {
		answers.push((call) => {
			if ("https://github.com/user-attachments/files/1/patch.diff" === call.url) {
				return new Response(null, { status: 302, headers: { location: "https://objects.githubusercontent.com/signed/patch.diff?sig=1" } });
			}
			if (call.url.startsWith("https://objects.githubusercontent.com/")) {
				return new Response("--- a", { headers: { "content-type": "text/x-diff; charset=utf-8", "content-disposition": "attachment; filename=patch.diff" } });
			}

			return undefined;
		});

		const upload = await client.fetchUpload("https://github.com/user-attachments/files/1/patch.diff");
		expect(upload.filename).toBe("patch.diff");
		expect(upload.contentType).toBe("text/x-diff");
		expect(new TextDecoder().decode(upload.content)).toBe("--- a");

		const [first, second] = calls.filter((call) => !call.url.includes("access_tokens"));
		expect(first!.headers.get("authorization")).toBe("Bearer token-1");
		expect(second!.headers.get("authorization")).toBeNull();
	});

	it("refuses to fetch a file from another host", async () => {
		answers.push((call) => ("https://github.com/user-attachments/files/2/x" === call.url
			? new Response(null, { status: 302, headers: { location: "https://example.net/x" } })
			: undefined));

		await expect(client.fetchUpload("https://github.com/user-attachments/files/2/x")).rejects.toMatchObject({ transient: false });
		await expect(client.fetchUpload("https://example.net/file")).rejects.toMatchObject({ transient: false });
		await expect(client.fetchUpload("http://github.com/user-attachments/files/3/x")).rejects.toMatchObject({ transient: false });
		expect(calls.some((call) => call.url.startsWith("https://example.net"))).toBe(false);
	});
});

describe("private key", () => {
	it("refuses a PKCS#1 key with the conversion command", async () => {
		await expect(importPrivateKey("-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----")).rejects.toThrow(ConfigError);
		await expect(importPrivateKey("-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----")).rejects.toThrow("openssl pkcs8 -topk8 -nocrypt");
	});

	it("accepts a key whose newlines were escaped", async () => {
		const { pem } = await keyPair();

		await expect(importPrivateKey(pem.replace(/\n/g, "\\n"))).resolves.toBeDefined();
	});
});

describe("mailer", () => {
	const mail = {
		to: { address: "reporter@example.org", name: "Rita Reporter" },
		cc: [],
		from: { address: "list-bot@mail.example.com", name: "maintainer via Example List" },
		replyTo: "list@example.com",
		subject: "Re: A question",
		text: "Hello",
		html: "<p>Hello</p>",
		headers: { "In-Reply-To": "<root@example.org>" },
		attachments: [{ filename: "a.txt", type: "text/plain", content: new Uint8Array([97]) }],
	};

	it("maps an email to the builder of the binding, and returns the Message-ID", async () => {
		const sent: unknown[] = [];
		const mailer = new CloudflareMailer({ send: async (message: unknown) => (sent.push(message), { messageId: "<generated@mail.example.com>" }) } as unknown as SendEmail);

		expect(await mailer.send(mail)).toBe("generated@mail.example.com");
		expect(sent[0]).toEqual({
			to: { email: "reporter@example.org", name: "Rita Reporter" },
			from: { email: "list-bot@mail.example.com", name: "maintainer via Example List" },
			replyTo: "list@example.com",
			subject: "Re: A question",
			text: "Hello",
			html: "<p>Hello</p>",
			headers: { "In-Reply-To": "<root@example.org>" },
			attachments: [{ filename: "a.txt", type: "text/plain", content: new Uint8Array([97]), disposition: "attachment" }],
		});
	});

	it("tells transient errors of the email service from permanent ones", async () => {
		const failing = (error: unknown): CloudflareMailer => new CloudflareMailer({ send: async () => { throw error; } } as unknown as SendEmail);

		await expect(failing(Object.assign(new Error("slow down"), { code: "E_RATE_LIMIT_EXCEEDED" })).send(mail)).rejects.toMatchObject({ code: "E_RATE_LIMIT_EXCEEDED", transient: true });
		await expect(failing(Object.assign(new Error("no"), { code: "E_SENDER_NOT_VERIFIED" })).send(mail)).rejects.toMatchObject({ code: "E_SENDER_NOT_VERIFIED", transient: false });
		await expect(failing(new TypeError("bad arguments")).send(mail)).rejects.toBeInstanceOf(MailError);
	});
});
