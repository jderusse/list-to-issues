import type { Config } from "../config";
import { createAppJwt, importPrivateKey } from "./auth";
import { type GitHub, type GitHubComment, GitHubError, type GitHubIssueSummary, type Reaction, type Upload } from "./types";

const API = "https://api.github.com";
const ROLES = ["read", "triage", "write", "maintain", "admin"];

// Installation tokens live for an hour: one is kept per isolate until shortly before it expires.
const tokens = new Map<string, { token: string; expiresAt: number }>();

function retryAfter(response: Response): number | null {
	const header = Number(response.headers.get("retry-after"));
	if (Number.isFinite(header) && header > 0) {
		return header;
	}
	const reset = Number(response.headers.get("x-ratelimit-reset"));
	if ("0" === response.headers.get("x-ratelimit-remaining") && Number.isFinite(reset) && reset > 0) {
		return Math.max(1, reset - Math.floor(Date.now() / 1000));
	}

	return null;
}

async function toError(response: Response): Promise<GitHubError> {
	const text = (await response.text().catch(() => "")).slice(0, 500);
	const limited = 429 === response.status
		|| (403 === response.status && (response.headers.has("retry-after") || "0" === response.headers.get("x-ratelimit-remaining") || /rate limit/i.test(text)));

	return new GitHubError(`GitHub answered ${response.status}`, response.status, response.status >= 500 || limited, retryAfter(response));
}

export class GitHubClient implements GitHub {
	private readonly labels = new Set<string>();
	private key: Promise<CryptoKey> | null = null;

	constructor(
		private readonly cfg: Config,
		private readonly now: () => Date = () => new Date(),
	) {}

	private get repo(): string {
		return `/repos/${this.cfg.repoOwner}/${this.cfg.repoName}`;
	}

	private async token(): Promise<string> {
		const cached = tokens.get(this.cfg.installationId);
		if (cached && cached.expiresAt - 60_000 > this.now().getTime()) {
			return cached.token;
		}
		this.key ??= importPrivateKey(this.cfg.privateKey);
		const jwt = await createAppJwt(this.cfg.appId, await this.key, this.now());
		const response = await fetch(`${API}/app/installations/${this.cfg.installationId}/access_tokens`, {
			method: "POST",
			headers: this.headers(jwt),
		});
		if (!response.ok) {
			throw await toError(response);
		}
		const data = await response.json<{ token: string; expires_at: string }>();
		tokens.set(this.cfg.installationId, { token: data.token, expiresAt: Date.parse(data.expires_at) });

		return data.token;
	}

	private headers(token: string): Record<string, string> {
		return {
			authorization: `Bearer ${token}`,
			accept: "application/vnd.github+json",
			"x-github-api-version": "2022-11-28",
			"user-agent": "list-to-issues",
		};
	}

	private async request(method: string, path: string, body?: unknown, allow: number[] = []): Promise<Response> {
		const response = await fetch(`${API}${path}`, {
			method,
			headers: { ...this.headers(await this.token()), ...(undefined === body ? {} : { "content-type": "application/json" }) },
			body: undefined === body ? undefined : JSON.stringify(body),
		});
		if (401 === response.status) {
			tokens.delete(this.cfg.installationId);
			throw new GitHubError("GitHub answered 401", 401, true);
		}
		if (!response.ok && !allow.includes(response.status)) {
			throw await toError(response);
		}

		return response;
	}

	async createIssue(title: string, body: string, labels: string[], type?: string): Promise<number> {
		const response = await this.request("POST", `${this.repo}/issues`, { title, body, labels, ...(type ? { type } : {}) });

		return (await response.json<{ number: number }>()).number;
	}

	async createComment(issueNumber: number, body: string): Promise<number> {
		const response = await this.request("POST", `${this.repo}/issues/${issueNumber}/comments`, { body });

		return (await response.json<{ id: number }>()).id;
	}

	async getComment(commentId: number): Promise<GitHubComment | null> {
		const response = await this.request("GET", `${this.repo}/issues/comments/${commentId}`, undefined, [404]);
		if (404 === response.status) {
			return null;
		}
		const data = await response.json<{ id: number; body?: string; issue_url: string; created_at: string; user?: { login?: string; type?: string } }>();

		return {
			id: data.id,
			issueNumber: Number(data.issue_url.slice(data.issue_url.lastIndexOf("/") + 1)),
			body: data.body ?? "",
			login: data.user?.login ?? "",
			isBot: "Bot" === data.user?.type,
			createdAt: data.created_at,
		};
	}

	async listComments(issueNumber: number, since: string): Promise<{ id: number; body: string }[]> {
		const comments: { id: number; body: string }[] = [];
		for (let page = 1; page <= 5; page++) {
			const response = await this.request("GET", `${this.repo}/issues/${issueNumber}/comments?since=${encodeURIComponent(since)}&per_page=100&page=${page}`);
			const batch = await response.json<{ id: number; body?: string }[]>();
			comments.push(...batch.map((comment) => ({ id: comment.id, body: comment.body ?? "" })));
			if (batch.length < 100) {
				break;
			}
		}

		return comments;
	}

	async listRecentIssues(): Promise<GitHubIssueSummary[]> {
		const response = await this.request("GET", `${this.repo}/issues?state=all&sort=created&direction=desc&per_page=50`);
		const issues = await response.json<{ number: number; body?: string | null; pull_request?: unknown }[]>();

		return issues.filter((issue) => undefined === issue.pull_request).map((issue) => ({ number: issue.number, body: issue.body ?? "" }));
	}

	async ensureLabel(name: string): Promise<void> {
		if (this.labels.has(name)) {
			return;
		}
		// 422: the label already exists
		await this.request("POST", `${this.repo}/labels`, { name }, [422]);
		this.labels.add(name);
	}

	async addLabels(issueNumber: number, labels: string[]): Promise<void> {
		await this.request("POST", `${this.repo}/issues/${issueNumber}/labels`, { labels });
	}

	async removeLabel(issueNumber: number, label: string): Promise<void> {
		await this.request("DELETE", `${this.repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`, undefined, [404]);
	}

	async setIssueState(issueNumber: number, state: "open" | "closed", reason?: "not_planned" | "completed"): Promise<void> {
		await this.request("PATCH", `${this.repo}/issues/${issueNumber}`, undefined === reason ? { state } : { state, state_reason: reason });
	}

	async addReaction(commentId: number, reaction: Reaction): Promise<void> {
		await this.request("POST", `${this.repo}/issues/comments/${commentId}/reactions`, { content: reaction });
	}

	async getPermission(login: string): Promise<string> {
		const response = await this.request("GET", `${this.repo}/collaborators/${encodeURIComponent(login)}/permission`, undefined, [404]);
		if (404 === response.status) {
			return "none";
		}
		const data = await response.json<{ permission?: string; role_name?: string }>();

		return ROLES.includes(data.role_name ?? "") ? data.role_name! : data.permission ?? "none";
	}

	async renderMarkdown(text: string): Promise<string> {
		// No repository context: "#123" must not become a link to the repository
		const response = await this.request("POST", "/markdown", { text, mode: "gfm" });

		return response.text();
	}

	// Files uploaded into a comment need the installation token. Redirects are followed by
	// hand, to GitHub hosts only, and the token never leaves github.com.
	async fetchUpload(url: string): Promise<Upload> {
		let current = new URL(url);
		for (let hop = 0; hop < 5; hop++) {
			const host = current.hostname.toLowerCase();
			if ("https:" !== current.protocol || !("github.com" === host || host.endsWith(".githubusercontent.com"))) {
				throw new GitHubError("Unexpected host for an uploaded file", 0, false);
			}
			const response = await fetch(current, {
				redirect: "manual",
				headers: "github.com" === host ? this.headers(await this.token()) : { "user-agent": "list-to-issues" },
			});
			if (response.status >= 300 && response.status < 400 && response.headers.has("location")) {
				current = new URL(response.headers.get("location")!, current);
				continue;
			}
			if (!response.ok) {
				throw await toError(response);
			}
			const disposition = response.headers.get("content-disposition") ?? "";
			const filename = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1] ?? /filename="?([^";]+)"?/i.exec(disposition)?.[1] ?? "";
			let decoded = filename;
			try {
				decoded = decodeURIComponent(filename);
			} catch {
				// Keep the name as sent
			}

			return {
				filename: decoded || decodeURIComponent(current.pathname.slice(current.pathname.lastIndexOf("/") + 1)),
				contentType: (response.headers.get("content-type") ?? "application/octet-stream").split(";")[0]!.trim(),
				content: new Uint8Array(await response.arrayBuffer()),
			};
		}

		throw new GitHubError("Too many redirects for an uploaded file", 0, false);
	}
}

export function forgetTokens(): void {
	tokens.clear();
}
