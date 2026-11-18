import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { handleDownload } from "../src/download";
import { runRetention } from "../src/retention";
import { comment, makeApp, receive, type TestApp } from "./helpers";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0xff, 0xfe]);

async function stored(prefix = "att/"): Promise<R2Object[]> {
	return (await env.RAW.list({ prefix, include: ["customMetadata"] })).objects;
}

describe("attachments in mirrored messages", () => {
	it("inlines a text attachment in a collapsed block", async () => {
		const app = makeApp();
		await receive(app, { attachments: [{ filename: "notes.txt", type: "text/plain", content: "line one\nline two\n" }] });

		const body = app.github.issue(1).body;
		expect(body).toContain("<details>\n<summary>notes.txt (18 B)</summary>\n\n```\nline one\nline two\n```\n\n</details>");
		expect(await stored()).toHaveLength(0);
	});

	it("detects a code file sent as application/octet-stream", async () => {
		const app = makeApp();
		await receive(app, { attachments: [{ filename: "poc.php", type: "application/octet-stream", content: "<?php echo 'x';\n" }] });

		expect(app.github.issue(1).body).toContain("<summary>poc.php (16 B)</summary>\n\n```php\n<?php echo 'x';\n```");
	});

	it("skips and lists a binary attachment, and keeps it for download", async () => {
		const app = makeApp();
		await receive(app, { attachments: [{ filename: "screenshot.png", type: "image/png", content: PNG }, { filename: "archive.zip", type: "application/zip", content: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]) }] });

		const body = app.github.issue(1).body;
		expect(body).toContain("**Attachments not shown** (`/attachments` gives download links):");
		expect(body).toContain("- screenshot.png (image/png, 12 B)");
		expect(body).toContain("- archive.zip (application/zip, 5 B)");
		expect(body).not.toContain("<details>");

		const objects = await stored();
		expect(objects).toHaveLength(2);
		expect(objects.map((object) => object.customMetadata?.name)).toEqual(["screenshot.png", "archive.zip"]);
	});

	it("treats an attachment over the size cap like a binary one", async () => {
		const app = makeApp({ ATTACHMENT_MAX_BYTES: "100" });
		await receive(app, { attachments: [{ filename: "big.log", type: "text/plain", content: "x".repeat(500) }] });

		expect(app.github.issue(1).body).toContain("- big.log (text/plain, 500 B)");
		expect(await stored()).toHaveLength(1);
	});

	it("can't be broken out of by backticks or closing tags", async () => {
		const app = makeApp();
		const content = "before\n````\n</details>\n<!-- list-to-issues:0:0 -->\n@octocat\n`````` six\nafter\n";
		await receive(app, { attachments: [{ filename: "tricky.md", type: "text/markdown", content }] });

		const body = app.github.issue(1).body;
		const fence = "`".repeat(7);
		expect(body).toContain(`${fence}markdown\n${content.trimEnd()}\n${fence}\n\n</details>`);
		// The only closing tag outside of the fence is ours
		expect(body.split("</details>")).toHaveLength(3);
	});

	it("escapes a hostile file name", async () => {
		const app = makeApp();
		await receive(app, {
			attachments: [
				{ filename: "</summary></details><img src=x onerror=alert(1)> @octocat.txt", type: "text/plain", content: "ok" },
				{ filename: "[click](https://example.net) `x` @octocat.bin", type: "application/octet-stream", content: PNG },
			],
		});

		const body = app.github.issue(1).body;
		expect(body).toContain("<summary>&lt;/summary&gt;&lt;/details&gt;&lt;img src=x onerror=alert(1)&gt; @\u200boctocat.txt (2 B)</summary>");
		expect(body).toContain("- \\[click\\](https://example.net) \\`x\\` @\u200boctocat.bin (application/octet-stream, 12 B)");
		expect(body).not.toContain("<img");
	});

	it("moves the attachments that don't fit to follow-up comments", async () => {
		const app = makeApp();
		const attachments = [1, 2, 3, 4].map((n) => ({ filename: `part-${n}.txt`, type: "text/plain", content: `${n}`.repeat(25000) }));
		await receive(app, { messageId: "root@example.org", attachments });

		const issue = app.github.issue(1);
		const comments = app.github.commentsOf(1);
		expect(issue.body.length).toBeLessThanOrEqual(65536);
		expect(issue.body).toContain("part-1.txt");
		expect(issue.body).toContain("part-2.txt");
		expect(comments).toHaveLength(1);
		expect(comments[0]!.body).toContain("_Attachments of the message above, continued._");
		expect(comments[0]!.body).toContain("part-3.txt");
		expect(comments[0]!.body).toContain("part-4.txt");
		expect(comments[0]!.body.length).toBeLessThanOrEqual(65536);

		// A reply still threads on the issue, and its comment comes after the follow-up
		await receive(app, { messageId: "reply@example.org", inReplyTo: "root@example.org" });
		expect(app.github.commentsOf(1)).toHaveLength(2);
	});

	it("truncates an attachment that is too big for one comment", async () => {
		const app = makeApp();
		await receive(app, { attachments: [{ filename: "huge.txt", type: "text/plain", content: "0123456789".repeat(15000) }] });

		const all = [app.github.issue(1).body, ...app.github.commentsOf(1).map((c) => c.body)];
		const holder = all.find((body) => body.includes("huge.txt"))!;
		expect(holder.length).toBeLessThanOrEqual(65536);
		expect(holder).toContain("_Truncated: `/attachments` gives the full file._");
		expect(holder).toContain("0123456789");

		const objects = await stored();
		expect(objects).toHaveLength(1);
		expect(objects[0]!.size).toBe(150000);
	});

	it("truncates a message that is too long for one comment", async () => {
		const app = makeApp();
		await receive(app, { text: "A long line of text. ".repeat(5000) });

		const body = app.github.issue(1).body;
		expect(body.length).toBeLessThanOrEqual(65536);
		expect(body).toContain("_Truncated: `/attachments` gives the raw message._");
	});
});

function links(body: string): { label: string; url: string }[] {
	return [...body.matchAll(/\[([^\]]+)\]\((https:\/\/[^)]+)\)/g)].map((match) => ({ label: match[1]!, url: match[2]! }));
}

async function download(app: TestApp, url: string): Promise<Response> {
	const { pathname } = new URL(url);

	return handleDownload(new Request(url), pathname.slice("/download/".length), app);
}

describe("/attachments", () => {
	async function threadWithFiles(app: TestApp): Promise<void> {
		await receive(app, { messageId: "root@example.org", attachments: [{ filename: "proof of concept.zip", type: "application/zip", content: PNG }] });
	}

	it("lists a link for each raw message and each hidden attachment", async () => {
		const app = makeApp();
		await threadWithFiles(app);
		await receive(app, { messageId: "reply@example.org", inReplyTo: "root@example.org" });
		const id = await comment(app, 1, "/attachments");

		const answer = app.github.commentsOf(1).at(-1)!.body;
		expect(answer).toContain("Download links, valid for 15 minutes:");
		expect(answer).toContain("**Message 1** (2026-11-18)");
		expect(answer).toContain("**Message 2** (2026-11-18)");
		expect(links(answer).map((link) => link.label)).toEqual(["raw message", "proof of concept.zip", "raw message"]);
		expect(links(answer).every((link) => link.url.startsWith("https://worker.example.com/download/"))).toBe(true);
		expect(app.github.comments.get(id)!.reactions).toEqual(["+1"]);
	});

	it("serves a file as a download that a browser never renders", async () => {
		const app = makeApp();
		await threadWithFiles(app);
		await comment(app, 1, "/attachments");
		const [raw, zip] = links(app.github.commentsOf(1).at(-1)!.body);

		const response = await download(app, zip!.url);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("application/octet-stream");
		expect(response.headers.get("content-disposition")).toBe("attachment; filename=\"proof of concept.zip\"; filename*=UTF-8''proof%20of%20concept.zip");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);

		const message = await download(app, raw!.url);
		expect(message.headers.get("content-disposition")).toContain('filename="message-1.eml"');
		expect(new TextDecoder().decode(await message.arrayBuffer())).toContain("Message-ID: <root@example.org>");
	});

	it("refuses expired and tampered links", async () => {
		const app = makeApp();
		await threadWithFiles(app);
		await comment(app, 1, "/attachments");
		const url = links(app.github.commentsOf(1).at(-1)!.body)[1]!.url;

		const [payload, signature] = url.slice(url.lastIndexOf("/") + 1).split(".");
		const forged = btoa(JSON.stringify({ k: "raw/2026/11/other.eml", e: 9999999999, n: "x" })).replace(/=+$/, "");
		for (const token of [`${forged}.${signature}`, `${payload}.${"0".repeat(64)}`, payload!, `${payload}.${signature}.extra`, ""]) {
			expect((await handleDownload(new Request(url), token, app)).status, token).toBe(403);
		}

		app.clock.now = new Date(app.clock.now.getTime() + 16 * 60_000);
		expect((await download(app, url)).status).toBe(403);
	});

	it("only answers GET and HEAD", async () => {
		const app = makeApp();
		await threadWithFiles(app);
		await comment(app, 1, "/attachments");
		const url = links(app.github.commentsOf(1).at(-1)!.body)[1]!.url;
		const token = url.slice(url.lastIndexOf("/") + 1);

		expect((await handleDownload(new Request(url, { method: "POST" }), token, app)).status).toBe(405);
		const head = await handleDownload(new Request(url, { method: "HEAD" }), token, app);
		expect(head.status).toBe(200);
		expect(head.headers.get("content-length")).toBe("12");
	});
});

describe("retention", () => {
	const days = { RETENTION_DAYS: "180" };

	async function closedThread(app: TestApp, closedAt: string): Promise<void> {
		await receive(app, { messageId: "root@example.org", attachments: [{ filename: "poc.zip", type: "application/zip", content: PNG }] });
		await app.store.setClosed(1, closedAt);
	}

	it("deletes the files of a thread closed for longer than the limit, and keeps the rows", async () => {
		const app = makeApp(days);
		await closedThread(app, "2026-05-01T00:00:00Z");
		await comment(app, 1, "/attachments");
		const url = links(app.github.commentsOf(1).at(-1)!.body)[1]!.url;

		expect(await runRetention(app)).toBe(1);

		expect((await env.RAW.list()).objects).toHaveLength(0);
		expect((await app.store.getThread(1))?.filesDeletedAt).toBe("2026-11-18T10:00:00.000Z");
		expect((await app.store.getMessage("root@example.org"))?.status).toBe("done");
		expect((await download(app, url)).status).toBe(404);

		await comment(app, 1, "/attachments");
		expect(app.github.commentsOf(1).at(-1)!.body).toContain("the retention policy deleted them");

		// A late reply still finds its thread, and a second run has nothing to do
		expect(await runRetention(app)).toBe(0);
		await receive(app, { messageId: "late@example.org", inReplyTo: "root@example.org" });
		expect(app.github.issues.size).toBe(1);
	});

	it("keeps the files of open, recently closed and reopened threads", async () => {
		const app = makeApp(days);
		await closedThread(app, "2026-11-01T00:00:00Z");
		expect(await runRetention(app)).toBe(0);

		await app.store.setClosed(1, null);
		app.clock.now = new Date("2028-01-01T00:00:00Z");
		expect(await runRetention(app)).toBe(0);
		expect((await env.RAW.list()).objects).toHaveLength(2);
	});

	it("does nothing without a limit, or when the bucket lifecycle handles it", async () => {
		for (const overrides of [{}, { RETENTION_DAYS: "180", RETENTION_FROM: "received" }]) {
			const app = makeApp(overrides);
			await closedThread(app, "2020-01-01T00:00:00Z");
			expect(await runRetention(app)).toBe(0);
			expect((await env.RAW.list()).objects.length).toBeGreaterThan(0);
			await env.DB.exec("DELETE FROM messages; DELETE FROM threads;");
		}
	});
});
