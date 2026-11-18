import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config";
import { buildMail, comment, deliver, drainInbound, makeApp, receive, REPORTER, SENDER, testEnv } from "./helpers";

const SECRET_ADDRESS = "in-9f8a7c6b5d4e3f2a1b0c@mail.example.com";

describe("list-headers mode", () => {
	it("accepts a message delivered by the list", async () => {
		const app = makeApp();
		const delivery = await deliver(app, buildMail());

		expect(delivery.rejected).toBeNull();
		expect(app.inbound).toHaveLength(1);
		expect(app.inbound[0]!.r2Key).toMatch(/^raw\/2026\/11\/[0-9a-f-]{36}\.eml$/);
	});

	it("rejects a message whose envelope sender isn't the list", async () => {
		const app = makeApp();
		const delivery = await deliver(app, buildMail(), { from: REPORTER });

		expect(delivery.rejected).not.toBeNull();
		expect(app.inbound).toHaveLength(0);
		expect((await env.RAW.list()).objects).toHaveLength(0);
	});

	it("rejects a message with another List-Id", async () => {
		const app = makeApp();
		const delivery = await deliver(app, buildMail({ listHeaders: false, headers: { "List-Id": "Other <other.example.com>" } }));

		expect(delivery.rejected).not.toBeNull();
	});

	it("rejects a message without List-Id", async () => {
		const app = makeApp();

		expect((await deliver(app, buildMail({ listHeaders: false }))).rejected).not.toBeNull();
	});
});

describe("secret-address mode", () => {
	const mode = { ACCEPT_MODE: "secret-address", INBOUND_ADDRESS: SECRET_ADDRESS };

	it("accepts what reaches the inbound address, without any list header", async () => {
		const app = makeApp(mode);
		const delivery = await deliver(app, buildMail({ listHeaders: false }), { from: REPORTER, to: SECRET_ADDRESS.toUpperCase() });
		await drainInbound(app);

		expect(delivery.rejected).toBeNull();
		expect(app.github.issues.size).toBe(1);
	});

	it("rejects any other address", async () => {
		const app = makeApp(mode);

		for (const to of ["in-0000000000000000000@mail.example.com", SENDER, "list@example.com"]) {
			expect((await deliver(app, buildMail(), { from: REPORTER, to })).rejected).not.toBeNull();
		}
		expect(app.inbound).toHaveLength(0);
	});

	it("can require headers on top", async () => {
		const app = makeApp({ ...mode, ACCEPT_HEADER_CHECKS: '[{"name": "X-Relay", "pattern": "^relay\\\\.example\\\\.com$"}]' });

		expect((await deliver(app, buildMail(), { to: SECRET_ADDRESS })).rejected).not.toBeNull();
		expect((await deliver(app, buildMail({ headers: { "X-Relay": "other.example.com" } }), { to: SECRET_ADDRESS })).rejected).not.toBeNull();
		expect((await deliver(app, buildMail({ headers: { "X-Relay": "relay.example.com" } }), { to: SECRET_ADDRESS })).rejected).toBeNull();
	});

	it("never shows the inbound address on GitHub, in emails or in logs", async () => {
		const app = makeApp(mode);
		await deliver(app, buildMail({ messageId: "root@example.org", to: `list@example.com, ${SECRET_ADDRESS}` }), { from: REPORTER, to: SECRET_ADDRESS });
		await drainInbound(app);
		await comment(app, 1, "/reply\nThanks.");

		const everything = JSON.stringify([[...app.github.issues.values()].map((issue) => issue.body), [...app.github.comments.values()].map((c) => c.body), app.mailer.sent, app.logs]);
		expect(everything).not.toContain(SECRET_ADDRESS);
		expect((await app.store.getThread(1))?.extraRecipients).toEqual([]);
	});
});

describe("observe mode", () => {
	it("stores every message and does nothing else", async () => {
		const app = makeApp({ OBSERVE_MODE: "true" });
		const delivery = await deliver(app, buildMail({ listHeaders: false }), { from: "anyone@example.net", to: "whatever@mail.example.com" });

		expect(delivery.rejected).toBeNull();
		expect(app.inbound).toHaveLength(0);
		expect(app.github.calls).toHaveLength(0);

		const { objects } = await env.RAW.list({ include: ["customMetadata"] });
		expect(objects).toHaveLength(1);
		expect(objects[0]!.key).toMatch(/^observe\/2026\/11\//);
		expect(objects[0]!.customMetadata).toEqual({ envelopeFrom: "anyone@example.net", envelopeTo: "whatever@mail.example.com" });
	});

	it("doesn't need the acceptance settings yet", () => {
		expect(() => loadConfig(testEnv({ OBSERVE_MODE: "true", ACCEPT_MODE: "secret-address" }))).not.toThrow();
	});
});

describe("email handler", () => {
	it("fails the delivery when the raw message can't be stored", async () => {
		const app = makeApp();
		app.raw = { put: async () => { throw new Error("R2 is down"); } } as unknown as R2Bucket;

		await expect(deliver(app, buildMail())).rejects.toThrow("R2 is down");
		expect(app.inbound).toHaveLength(0);
	});

	it("logs outcomes and hashes only", async () => {
		const app = makeApp();
		await receive(app, { messageId: "root@example.org", subject: "A very secret subject", attachments: [{ filename: "secret-name.bin", type: "application/octet-stream", content: new Uint8Array([0, 1, 2]) }] });
		await deliver(app, buildMail(), { from: "intruder@example.net" });
		await comment(app, 1, "/reply\nThe body of the reply.");

		const logs = JSON.stringify(app.logs);
		expect(app.logs.length).toBeGreaterThan(3);
		for (const secret of [REPORTER, "intruder@example.net", "A very secret subject", "secret-name.bin", "The body of the reply", "root@example.org", "raw/2026"]) {
			expect(logs).not.toContain(secret);
		}
	});
});

describe("configuration", () => {
	it("explains what is missing or wrong", () => {
		const cases: [Record<string, string>, string][] = [
			[{ GITHUB_REPO: "no-slash" }, "GITHUB_REPO"],
			[{ LIST_ADDRESS: "not an address" }, "LIST_ADDRESS"],
			[{ ACCEPT_MODE: "anything" }, "ACCEPT_MODE"],
			[{ LIST_ID: "" }, "list-headers mode"],
			[{ LIST_BOUNCE_PATTERN: "(" }, "LIST_BOUNCE_PATTERN"],
			[{ ACCEPT_MODE: "secret-address" }, "INBOUND_ADDRESS"],
			[{ ACCEPT_MODE: "secret-address", INBOUND_ADDRESS: SENDER }, "must differ"],
			[{ ACCEPT_HEADER_CHECKS: "{}" }, "ACCEPT_HEADER_CHECKS"],
			[{ HMAC_SECRET: "too-short" }, "HMAC_SECRET"],
			[{ MIN_PERMISSION: "owner" }, "MIN_PERMISSION"],
			[{ RETENTION_DAYS: "soon" }, "RETENTION_DAYS"],
			[{ RETENTION_FROM: "never" }, "RETENTION_FROM"],
			[{ GITHUB_WEBHOOK_SECRET: "" }, "GITHUB_WEBHOOK_SECRET"],
		];
		for (const [overrides, message] of cases) {
			expect(() => loadConfig(testEnv(overrides)), JSON.stringify(overrides)).toThrow(ConfigError);
			expect(() => loadConfig(testEnv(overrides))).toThrow(message);
		}
	});

	it("has the documented defaults", () => {
		const cfg = loadConfig(testEnv());

		expect(cfg.defaultOutboundMode).toBe("none");
		expect(cfg.minPermission).toBe("write");
		expect(cfg.labelsNew).toEqual(["via-email"]);
		expect(cfg.labelAwaitingReply).toBe("needs-reply");
		expect(cfg.ccList).toBe(false);
		expect(cfg.ccExtraRecipients).toBe(true);
		expect(cfg.retentionDays).toBeNull();
		expect(cfg.retentionFrom).toBe("closed");
		expect(cfg.downloadLinkTtl).toBe(900);
		expect(cfg.observe).toBe(false);
	});
});
