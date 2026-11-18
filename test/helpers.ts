import { env } from "cloudflare:workers";
import type { App, Mailer, OutgoingEmail } from "../src/app";
import { loadConfig } from "../src/config";
import { hmacHex } from "../src/crypto";
import type { Env } from "../src/env";
import { type GitHub, type GitHubComment, GitHubError, type GitHubIssueSummary, type Reaction, type Upload } from "../src/github/types";
import { handleEmail, type IncomingMessage } from "../src/inbound/email";
import { processInbound } from "../src/inbound/consumer";
import type { InboundJob, JobResult, OutboundJob } from "../src/jobs";
import { processOutbound } from "../src/outbound/consumer";
import { handleWebhook } from "../src/outbound/webhook";
import { Store } from "../src/store";

export const LIST = "list@example.com";
export const BOUNCE = "list+bounces-123@example.com";
export const SENDER = "list-bot@mail.example.com";
export const REPORTER = "reporter@example.org";
export const WEBHOOK_SECRET = "webhook-secret-for-tests";
export const BOT_LOGIN = "list-to-issues[bot]";

interface FakeIssue {
	title: string;
	body: string;
	labels: Set<string>;
	state: "open" | "closed";
	reason: string | null;
	type?: string;
}

interface FakeComment extends GitHubComment {
	reactions: Reaction[];
}

type Method = keyof GitHub;

export class FakeGitHub implements GitHub {
	issues = new Map<number, FakeIssue>();
	comments = new Map<number, FakeComment>();
	labels = new Set<string>();
	permissions = new Map<string, string>();
	uploads = new Map<string, Upload>();
	calls: Method[] = [];
	private failures: { method: Method; error: Error; after: boolean }[] = [];
	private nextIssue = 1;
	private nextComment = 1000;

	constructor(private readonly now: () => Date) {}

	// Makes the next call of a method fail. With `after`, the call takes effect first,
	// as when the response of a successful request is lost.
	failNext(method: Method, options: { error?: Error; after?: boolean } = {}): void {
		this.failures.push({ method, error: options.error ?? new GitHubError("unavailable", 503, true), after: options.after ?? false });
	}

	private async run<T>(method: Method, action: () => T): Promise<T> {
		this.calls.push(method);
		const index = this.failures.findIndex((failure) => failure.method === method);
		if (-1 === index) {
			return action();
		}
		const [failure] = this.failures.splice(index, 1);
		if (failure!.after) {
			action();
		}
		throw failure!.error;
	}

	issue(number: number): FakeIssue {
		const issue = this.issues.get(number);
		if (!issue) {
			throw new Error(`No issue ${number}`);
		}

		return issue;
	}

	commentsOf(issueNumber: number): FakeComment[] {
		return [...this.comments.values()].filter((comment) => comment.issueNumber === issueNumber);
	}

	// A comment written by a person on GitHub
	userComment(issueNumber: number, login: string, body: string): number {
		const id = this.nextComment++;
		this.comments.set(id, { id, issueNumber, body, login, isBot: false, createdAt: this.now().toISOString(), reactions: [] });

		return id;
	}

	createIssue(title: string, body: string, labels: string[], type?: string): Promise<number> {
		return this.run("createIssue", () => {
			const number = this.nextIssue++;
			this.issues.set(number, { title, body, labels: new Set(labels), state: "open", reason: null, type });

			return number;
		});
	}

	createComment(issueNumber: number, body: string): Promise<number> {
		return this.run("createComment", () => {
			this.issue(issueNumber);
			const id = this.nextComment++;
			this.comments.set(id, { id, issueNumber, body, login: BOT_LOGIN, isBot: true, createdAt: this.now().toISOString(), reactions: [] });

			return id;
		});
	}

	getComment(commentId: number): Promise<GitHubComment | null> {
		return this.run("getComment", () => this.comments.get(commentId) ?? null);
	}

	listComments(issueNumber: number): Promise<{ id: number; body: string }[]> {
		return this.run("listComments", () => this.commentsOf(issueNumber).map(({ id, body }) => ({ id, body })));
	}

	listRecentIssues(): Promise<GitHubIssueSummary[]> {
		return this.run("listRecentIssues", () => [...this.issues.entries()].map(([number, issue]) => ({ number, body: issue.body })));
	}

	ensureLabel(name: string): Promise<void> {
		return this.run("ensureLabel", () => {
			this.labels.add(name);
		});
	}

	addLabels(issueNumber: number, labels: string[]): Promise<void> {
		return this.run("addLabels", () => {
			for (const label of labels) {
				this.issue(issueNumber).labels.add(label);
			}
		});
	}

	removeLabel(issueNumber: number, label: string): Promise<void> {
		return this.run("removeLabel", () => {
			this.issue(issueNumber).labels.delete(label);
		});
	}

	setIssueState(issueNumber: number, state: "open" | "closed", reason?: "not_planned" | "completed"): Promise<void> {
		return this.run("setIssueState", () => {
			const issue = this.issue(issueNumber);
			issue.state = state;
			issue.reason = reason ?? null;
		});
	}

	addReaction(commentId: number, reaction: Reaction): Promise<void> {
		return this.run("addReaction", () => {
			this.comments.get(commentId)?.reactions.push(reaction);
		});
	}

	getPermission(login: string): Promise<string> {
		return this.run("getPermission", () => this.permissions.get(login) ?? "none");
	}

	renderMarkdown(text: string): Promise<string> {
		return this.run("renderMarkdown", () => `<p>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p>`);
	}

	fetchUpload(url: string): Promise<Upload> {
		return this.run("fetchUpload", () => {
			const upload = this.uploads.get(url);
			if (!upload) {
				throw new GitHubError("not found", 404, false);
			}

			return upload;
		});
	}
}

export class FakeMailer implements Mailer {
	sent: OutgoingEmail[] = [];
	private failures: Error[] = [];
	private counter = 0;

	failNext(error: Error): void {
		this.failures.push(error);
	}

	async send(mail: OutgoingEmail): Promise<string> {
		const failure = this.failures.shift();
		if (failure) {
			throw failure;
		}
		this.sent.push(mail);

		return `sent-${++this.counter}@mail.example.com`;
	}

	last(): OutgoingEmail {
		const mail = this.sent[this.sent.length - 1];
		if (!mail) {
			throw new Error("No email was sent");
		}

		return mail;
	}
}

export interface TestApp extends App {
	github: FakeGitHub;
	mailer: FakeMailer;
	inbound: InboundJob[];
	outbound: OutboundJob[];
	clock: { now: Date };
	logs: { event: string; fields: Record<string, unknown> }[];
}

export function testEnv(overrides: Partial<Env> = {}): Env {
	return {
		...env,
		GITHUB_REPO: "example-org/example-repo",
		GITHUB_APP_ID: "1",
		GITHUB_INSTALLATION_ID: "2",
		LIST_ADDRESS: LIST,
		ACCEPT_MODE: "list-headers",
		LIST_ID: "list.example.com",
		LIST_BOUNCE_PATTERN: "^list\\+bounces-[^@]+@example\\.com$",
		SENDER_ADDRESS: SENDER,
		SENDER_LABEL: "Example List",
		SUBJECT_TAG: "[list]",
		FOOTER_PATTERN: "^-- \\nYou received this message because",
		GITHUB_APP_PRIVATE_KEY: "unused-in-tests",
		GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
		HMAC_SECRET: "an-hmac-secret-of-at-least-32-characters",
		...overrides,
	};
}

export function makeApp(overrides: Partial<Env> = {}): TestApp {
	const clock = { now: new Date("2026-11-18T10:00:00Z") };
	const inbound: InboundJob[] = [];
	const outbound: OutboundJob[] = [];
	const logs: TestApp["logs"] = [];

	return {
		cfg: loadConfig(testEnv(overrides)),
		store: new Store(env.DB),
		raw: env.RAW,
		github: new FakeGitHub(() => clock.now),
		mailer: new FakeMailer(),
		inboundQueue: { send: async (job) => void inbound.push(job) },
		outboundQueue: { send: async (job) => void outbound.push(job) },
		now: () => clock.now,
		log: (event, fields = {}) => void logs.push({ event, fields }),
		inbound,
		outbound,
		clock,
		logs,
	};
}

export interface MailOptions {
	from?: string;
	to?: string;
	cc?: string;
	replyTo?: string;
	subject?: string;
	messageId?: string | null;
	inReplyTo?: string;
	references?: string[];
	date?: string;
	text?: string;
	html?: string;
	headers?: Record<string, string>;
	// The header that the receiving server prepends; null for none
	auth?: string | null;
	listHeaders?: boolean;
	attachments?: { filename: string; type: string; content: string | Uint8Array; inline?: boolean }[];
}

let mailCounter = 0;

function base64(content: string | Uint8Array): string {
	const bytes = "string" === typeof content ? new TextEncoder().encode(content) : content;
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}

	return (btoa(binary).match(/.{1,76}/g) ?? []).join("\r\n");
}

// Builds a raw message the way it would reach the Worker.
export function buildMail(options: MailOptions = {}): string {
	const lines: string[] = [];
	const auth = undefined === options.auth ? "mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass" : options.auth;
	if (null !== auth) {
		lines.push(`Authentication-Results: ${auth}`);
	}
	lines.push(`From: ${options.from ?? `Rita Reporter <${REPORTER}>`}`);
	lines.push(`To: ${options.to ?? LIST}`);
	if (options.cc) {
		lines.push(`Cc: ${options.cc}`);
	}
	if (options.replyTo) {
		lines.push(`Reply-To: ${options.replyTo}`);
	}
	lines.push(`Subject: ${options.subject ?? "A question"}`);
	lines.push(`Date: ${options.date ?? "Wed, 18 Nov 2026 09:00:00 +0000"}`);
	if (null !== options.messageId) {
		lines.push(`Message-ID: <${options.messageId ?? `m${++mailCounter}@example.org`}>`);
	}
	if (options.inReplyTo) {
		lines.push(`In-Reply-To: <${options.inReplyTo}>`);
	}
	if (options.references?.length) {
		lines.push(`References: ${options.references.map((id) => `<${id}>`).join(" ")}`);
	}
	if (false !== options.listHeaders) {
		lines.push("List-Id: Example list <list.example.com>");
	}
	for (const [name, value] of Object.entries(options.headers ?? {})) {
		lines.push(`${name}: ${value}`);
	}
	lines.push("MIME-Version: 1.0");

	const text = options.text ?? (undefined === options.html ? "Hello,\n\nThis is the message.\n" : undefined);
	const parts: string[] = [];
	if (undefined !== text) {
		parts.push(`Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64(text)}`);
	}
	if (undefined !== options.html) {
		parts.push(`Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64(options.html)}`);
	}
	for (const attachment of options.attachments ?? []) {
		const name = attachment.filename.replace(/["\r\n]/g, "");
		parts.push(
			`Content-Type: ${attachment.type}; name="${name}"\r\n`
			+ `Content-Disposition: ${attachment.inline ? "inline" : "attachment"}; filename="${name}"\r\n`
			+ `Content-Transfer-Encoding: base64\r\n\r\n${base64(attachment.content)}`,
		);
	}

	if (1 === parts.length) {
		return `${lines.join("\r\n")}\r\n${parts[0]}\r\n`;
	}
	const boundary = "=_boundary_for_tests";
	lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);

	return `${lines.join("\r\n")}\r\n\r\n${parts.map((part) => `--${boundary}\r\n${part}\r\n`).join("")}--${boundary}--\r\n`;
}

function headersOf(raw: string): Headers {
	const headers = new Headers();
	const section = raw.slice(0, raw.indexOf("\r\n\r\n")).replace(/\r\n[ \t]+/g, " ");
	for (const line of section.split("\r\n")) {
		const colon = line.indexOf(":");
		if (colon > 0) {
			headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
		}
	}

	return headers;
}

export interface Delivery {
	rejected: string | null;
	forwarded: string[];
}

// Hands a raw message to the email() logic, as Email Routing would.
export async function deliver(app: TestApp, raw: string, envelope: { from?: string; to?: string } = {}): Promise<Delivery> {
	const bytes = new TextEncoder().encode(raw);
	const delivery: Delivery = { rejected: null, forwarded: [] };
	const message: IncomingMessage = {
		from: envelope.from ?? BOUNCE,
		to: envelope.to ?? "bot@mail.example.com",
		headers: headersOf(raw),
		raw: new Response(bytes).body!,
		rawSize: bytes.byteLength,
		setReject: (reason) => void (delivery.rejected = reason),
		forward: async (rcptTo) => void delivery.forwarded.push(rcptTo),
	};
	await handleEmail(message, app);

	return delivery;
}

async function drain<T>(jobs: T[], process: (job: T, attempts: number) => Promise<JobResult>): Promise<void> {
	const attempts = new Map<T, number>();
	for (let round = 0; jobs.length > 0; round++) {
		if (round > 40) {
			throw new Error("The queue doesn't drain");
		}
		const job = jobs.shift()!;
		const attempt = (attempts.get(job) ?? 0) + 1;
		attempts.set(job, attempt);
		let result: JobResult;
		try {
			result = await process(job, attempt);
		} catch (error) {
			if (!(error instanceof GitHubError) || !error.transient) {
				throw error;
			}
			result = { action: "retry", delaySeconds: 1 };
		}
		if ("retry" === result.action) {
			jobs.push(job);
		}
	}
}

// Runs the inbound consumer until the queue is empty, retrying as the Queue would.
export function drainInbound(app: TestApp): Promise<void> {
	return drain(app.inbound, (job, attempts) => processInbound(job, attempts, app));
}

export function drainOutbound(app: TestApp): Promise<void> {
	return drain(app.outbound, (job, attempts) => processOutbound(job, attempts, app));
}

// Delivers a message through the list and mirrors it.
export async function receive(app: TestApp, options: MailOptions = {}, envelope: { from?: string; to?: string } = {}): Promise<Delivery> {
	const delivery = await deliver(app, buildMail(options), envelope);
	await drainInbound(app);

	return delivery;
}

export async function webhook(app: TestApp, event: string, payload: unknown, options: { secret?: string; signature?: string } = {}): Promise<Response> {
	const body = JSON.stringify(payload);
	const signature = options.signature ?? `sha256=${await hmacHex(options.secret ?? WEBHOOK_SECRET, body)}`;

	return handleWebhook(new Request("https://worker.example.com/github/webhook", {
		method: "POST",
		headers: { "content-type": "application/json", "x-github-event": event, "x-hub-signature-256": signature },
		body,
	}), app);
}

// A person comments on GitHub: GitHub calls the webhook, and the Worker processes it.
export async function comment(app: TestApp, issue: number, body: string, login = "maintainer"): Promise<number> {
	if (!app.github.permissions.has(login)) {
		app.github.permissions.set(login, "write");
	}
	const id = app.github.userComment(issue, login, body);
	await webhook(app, "issue_comment", {
		action: "created",
		repository: { full_name: "example-org/example-repo" },
		installation: { id: 2 },
		issue: { number: issue },
		comment: { id, body, user: { login, type: "User" } },
		sender: { login, type: "User" },
	});
	await drainOutbound(app);

	return id;
}
