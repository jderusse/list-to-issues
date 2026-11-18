import { describe, expect, it } from "vitest";
import { GitHubError } from "../src/github/types";
import { buildMail, deliver, drainInbound, LIST, makeApp, receive, REPORTER } from "./helpers";

describe("inbound threading", () => {
	it("opens an issue for a new thread", async () => {
		const app = makeApp();
		await receive(app, { subject: "[list] Re: FW: A question", messageId: "root@example.org" });

		expect(app.github.issues.size).toBe(1);
		const issue = app.github.issue(1);
		expect(issue.title).toBe("A question");
		expect([...issue.labels]).toEqual(["via-email", "needs-reply"]);
		expect(issue.body).toContain("**From:** Rita Reporter &lt;reporter@example.org&gt;");
		expect(issue.body).toContain("**Message-ID:** root@example.org");
		expect(issue.body).toMatch(/\*\*Raw message:\*\* `raw\/2026\/11\/[0-9a-f-]+\.eml`/);
		expect(issue.body).toContain("SPF pass, DKIM pass, DMARC pass");
		expect(issue.body).toContain("This is the message.");

		const thread = await app.store.getThread(1);
		expect(thread?.reporter).toEqual({ address: REPORTER, name: "Rita Reporter" });
		expect(thread?.subject).toBe("A question");
	});

	it("uses a fallback title when the subject is empty", async () => {
		const app = makeApp();
		await receive(app, { subject: "[list] Re:" });

		expect(app.github.issue(1).title).toBe("(no subject)");
	});

	it("adds a reply as a comment, through In-Reply-To", async () => {
		const app = makeApp();
		await receive(app, { messageId: "root@example.org" });
		await receive(app, { messageId: "reply@example.org", inReplyTo: "root@example.org", from: "Someone Else <else@example.net>", text: "I can reproduce." });

		expect(app.github.issues.size).toBe(1);
		const comments = app.github.commentsOf(1);
		expect(comments).toHaveLength(1);
		expect(comments[0]!.body).toContain("I can reproduce.");
		expect(comments[0]!.body).toContain("else@example.net");
	});

	it("adds a reply as a comment, through References only", async () => {
		const app = makeApp();
		await receive(app, { messageId: "root@example.org" });
		await receive(app, { messageId: "second@example.org", references: ["unknown@example.net", "root@example.org"] });

		expect(app.github.issues.size).toBe(1);
		expect(app.github.commentsOf(1)).toHaveLength(1);
	});

	it("skips a duplicate delivery", async () => {
		const app = makeApp();
		await receive(app, { messageId: "root@example.org" });
		await receive(app, { messageId: "root@example.org" });

		expect(app.github.issues.size).toBe(1);
		expect(app.github.commentsOf(1)).toHaveLength(0);
	});

	it("waits for the parent of a reply that arrives first", async () => {
		const app = makeApp();
		await deliver(app, buildMail({ messageId: "reply@example.org", inReplyTo: "root@example.org", text: "The reply." }));
		await deliver(app, buildMail({ messageId: "root@example.org", text: "The first message." }));
		await drainInbound(app);

		expect(app.github.issues.size).toBe(1);
		expect(app.github.issue(1).body).toContain("The first message.");
		expect(app.github.commentsOf(1)[0]!.body).toContain("The reply.");
	});

	it("opens an unthreaded issue when the parent never shows up", async () => {
		const app = makeApp();
		await receive(app, { messageId: "orphan@example.org", inReplyTo: "never-seen@example.net" });

		expect(app.github.issues.size).toBe(1);
		expect(app.github.issue(1).labels.has("unthreaded")).toBe(true);
	});

	it("derives a stable id when the Message-ID is missing", async () => {
		const app = makeApp();
		const raw = buildMail({ messageId: null });
		await deliver(app, raw);
		await deliver(app, raw);
		await drainInbound(app);

		expect(app.github.issues.size).toBe(1);
		expect(app.github.issue(1).body).toMatch(/\*\*Message-ID:\*\* [0-9a-f]{40}@synthetic\.invalid/);
	});
});

describe("inbound sender and recipients", () => {
	it("recovers the author when the list rewrote From", async () => {
		const app = makeApp();
		await receive(app, { from: `"Rita Reporter via Example list" <${LIST}>`, replyTo: `Rita Reporter <${REPORTER}>` });

		expect((await app.store.getThread(1))?.reporter).toEqual({ address: REPORTER, name: "Rita Reporter" });
		expect(app.github.issue(1).body).toContain("reporter@example.org");
	});

	it("recovers the author from X-Original-From", async () => {
		const app = makeApp();
		await receive(app, { from: `Example list <${LIST}>`, headers: { "X-Original-From": `Rita <${REPORTER}>` } });

		expect((await app.store.getThread(1))?.reporter.address).toBe(REPORTER);
	});

	it("records the people that the reporter included", async () => {
		const app = makeApp();
		await receive(app, { messageId: "root@example.org", to: `${LIST}, Colleague <colleague@example.org>`, cc: "Lead <lead@example.org>" });

		expect((await app.store.getThread(1))?.extraRecipients).toEqual([
			{ address: "colleague@example.org", name: "Colleague" },
			{ address: "lead@example.org", name: "Lead" },
		]);

		// Recipients chosen by somebody else are not added
		await receive(app, { messageId: "other@example.org", inReplyTo: "root@example.org", from: "else@example.net", cc: "stranger@example.net" });
		expect((await app.store.getThread(1))?.extraRecipients).toHaveLength(2);
	});
});

describe("inbound body", () => {
	it("strips the quoted history and the list footer, and keeps the full text", async () => {
		const app = makeApp();
		await receive(app, { messageId: "root@example.org" });
		await receive(app, {
			messageId: "reply@example.org",
			inReplyTo: "root@example.org",
			text: "Thanks, here are the details.\n\nOn Wed, 18 Nov 2026 at 09:00, Someone <someone@example.com> wrote:\n> Could you tell us more?\n> Thanks\n\n-- \nYou received this message because you are subscribed to the list.\n",
		});

		const body = app.github.commentsOf(1)[0]!.body;
		const visible = body.slice(0, body.indexOf("<details>"));
		expect(visible).toContain("Thanks, here are the details.");
		expect(visible).not.toContain("Could you tell us more?");
		expect(visible).not.toContain("You received this message");
		expect(body).toContain("<summary>Full message text</summary>");
		expect(body.slice(body.indexOf("<details>"))).toContain("> Could you tell us more?");
	});

	it("keeps the quoted text of a first message", async () => {
		const app = makeApp();
		await receive(app, { text: "Forwarding this report.\n\nOn Tue, 17 Nov 2026, Someone <someone@example.com> wrote:\n> The actual report" });

		expect(app.github.issue(1).body).toContain("The actual report");
		expect(app.github.issue(1).body).not.toContain("Full message text");
	});

	it("converts an HTML-only message to text", async () => {
		const app = makeApp();
		await receive(app, { html: "<html><head><style>p{color:red}</style></head><body><p>Hello <b>there</b>,</p><p>See <a href=\"https://example.com/a_b\">this page</a>.<br>Bye &amp; thanks</p></body></html>" });

		const body = app.github.issue(1).body;
		expect(body).toContain("Hello there,");
		expect(body).toContain("this page (https://example.com/a_b)");
		expect(body).toContain("Bye &amp; thanks");
		expect(body).not.toContain("color:red");
	});

	it("neutralizes mentions, references and markup", async () => {
		const app = makeApp();
		await receive(app, {
			text: "Hi @octocat and @example-org/team, see #12.\n# Not a heading\n</details><img src=x>\n```\nunclosed fence\n<!-- list-to-issues:deadbeef:0 -->\n    indented\nMail me at someone@example.com or https://example.com/a_b?c=1&d=2",
		});

		const body = app.github.issue(1).body;
		expect(body).toContain("@\u200boctocat");
		expect(body).toContain("@\u200bexample-org/team");
		expect(body).toContain("#\u200b12");
		expect(body).toContain("\\# Not a heading");
		expect(body).toContain("&lt;/details&gt;&lt;img src=x&gt;");
		expect(body).toContain("\\`\\`\\`");
		expect(body).toContain("&lt;!-- list-to-issues:deadbeef:0 --&gt;");
		expect(body).toContain("&nbsp;&nbsp;&nbsp;&nbsp;indented");
		expect(body).toContain("someone@example.com");
		expect(body).toContain("https://example.com/a_b?c=1&amp;d=2");
		expect(body).not.toMatch(/(^|[^\\])```/m);
	});

	it("shows the authentication results of the receiving server only", async () => {
		const app = makeApp();
		await receive(app, { messageId: "a@example.org", auth: "mx.cloudflare.net; spf=fail; dkim=none; dmarc=fail" });
		await receive(app, { messageId: "b@example.org", auth: "mx.attacker.example; spf=pass; dkim=pass; dmarc=pass" });
		await receive(app, { messageId: "c@example.org", auth: null });

		expect(app.github.issue(1).body).toContain("SPF fail, DKIM none, DMARC fail :warning:");
		expect(app.github.issue(2).body).toContain("no result from the receiving server :warning:");
		expect(app.github.issue(3).body).toContain("no result from the receiving server :warning:");
	});
});

describe("inbound labels and state", () => {
	it("flags an automatic message and leaves the labels alone", async () => {
		const app = makeApp();
		await receive(app, { messageId: "root@example.org" });
		app.github.issue(1).labels.delete("needs-reply");
		await receive(app, { messageId: "ooo@example.org", inReplyTo: "root@example.org", headers: { "Auto-Submitted": "auto-replied" }, text: "I am away." });

		expect(app.github.commentsOf(1)[0]!.body).toContain("**Automatic message**");
		expect(app.github.issue(1).labels.has("needs-reply")).toBe(false);
	});

	it("adds the awaiting-reply label when the reporter writes again", async () => {
		const app = makeApp();
		await receive(app, { messageId: "root@example.org" });
		app.github.issue(1).labels.delete("needs-reply");

		await receive(app, { messageId: "member@example.org", inReplyTo: "root@example.org", from: "member@example.net" });
		expect(app.github.issue(1).labels.has("needs-reply")).toBe(false);

		await receive(app, { messageId: "again@example.org", inReplyTo: "root@example.org" });
		expect(app.github.issue(1).labels.has("needs-reply")).toBe(true);
	});

	it("reopens a closed issue when the reporter writes", async () => {
		const app = makeApp();
		await receive(app, { messageId: "root@example.org" });
		app.github.issue(1).state = "closed";
		await app.store.setClosed(1, "2026-11-18T09:30:00Z");

		await receive(app, { messageId: "again@example.org", inReplyTo: "root@example.org" });

		expect(app.github.issue(1).state).toBe("open");
		expect((await app.store.getThread(1))?.closedAt).toBeNull();
	});
});

describe("inbound retries", () => {
	it("retries when GitHub is unavailable or rate limited", async () => {
		const app = makeApp();
		app.github.failNext("createIssue");
		app.github.failNext("createIssue", { error: new GitHubError("secondary rate limit", 403, true, 30) });
		await receive(app, { messageId: "root@example.org" });

		expect(app.github.issues.size).toBe(1);
		expect((await app.store.getMessage("root@example.org"))?.status).toBe("done");
	});

	it("doesn't open a second issue when the first attempt was not recorded", async () => {
		const app = makeApp();
		// The issue is created, but the Worker never sees the answer
		app.github.failNext("createIssue", { after: true });
		await receive(app, { messageId: "root@example.org" });

		expect(app.github.issues.size).toBe(1);
		expect((await app.store.getThread(1))?.rootMessageId).toBe("root@example.org");
	});

	it("doesn't post a comment twice when the first attempt was not recorded", async () => {
		const app = makeApp();
		await receive(app, { messageId: "root@example.org" });
		app.github.failNext("createComment", { after: true });
		await receive(app, { messageId: "reply@example.org", inReplyTo: "root@example.org" });

		expect(app.github.commentsOf(1)).toHaveLength(1);
		expect((await app.store.getMessage("reply@example.org"))?.comment_id).toBe(app.github.commentsOf(1)[0]!.id);
	});
});
