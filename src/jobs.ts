// Queue payloads carry keys and ids only: Queue messages are size-limited.

export interface InboundJob {
	type: "email";
	r2Key: string;
}

export interface CommentJob {
	type: "comment";
	issue: number;
	commentId: number;
	// Origin of the webhook URL, to build download links
	origin: string;
}

export interface IssueStateJob {
	type: "issue_state";
	issue: number;
	closedAt: string | null;
}

export type OutboundJob = CommentJob | IssueStateJob;

export type JobResult = { action: "ack" } | { action: "retry"; delaySeconds: number };

export const ACK: JobResult = { action: "ack" };

export function retryIn(delaySeconds: number): JobResult {
	return { action: "retry", delaySeconds: Math.max(1, Math.min(Math.round(delaySeconds), 43200)) };
}

export function backoff(attempts: number): number {
	return Math.min(15 * 2 ** Math.max(0, attempts - 1), 900);
}
