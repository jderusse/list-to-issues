export type Reaction = "+1" | "-1" | "confused" | "rocket";

export interface GitHubComment {
	id: number;
	issueNumber: number;
	body: string;
	login: string;
	isBot: boolean;
	createdAt: string;
}

export interface GitHubIssueSummary {
	number: number;
	body: string;
}

export interface Upload {
	filename: string;
	contentType: string;
	content: Uint8Array;
}

// Everything the Worker asks GitHub. The tests use an in-memory implementation.
export interface GitHub {
	createIssue(title: string, body: string, labels: string[], type?: string): Promise<number>;
	createComment(issueNumber: number, body: string): Promise<number>;
	getComment(commentId: number): Promise<GitHubComment | null>;
	listComments(issueNumber: number, since: string): Promise<{ id: number; body: string }[]>;
	listRecentIssues(): Promise<GitHubIssueSummary[]>;
	ensureLabel(name: string): Promise<void>;
	addLabels(issueNumber: number, labels: string[]): Promise<void>;
	removeLabel(issueNumber: number, label: string): Promise<void>;
	setIssueState(issueNumber: number, state: "open" | "closed", reason?: "not_planned" | "completed"): Promise<void>;
	addReaction(commentId: number, reaction: Reaction): Promise<void>;
	getPermission(login: string): Promise<string>;
	renderMarkdown(text: string): Promise<string>;
	fetchUpload(url: string): Promise<Upload>;
}

export class GitHubError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly transient: boolean,
		readonly retryAfter: number | null = null,
	) {
		super(message);
	}
}
