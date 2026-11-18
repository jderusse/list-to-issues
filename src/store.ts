import type { Address } from "./addresses";

export interface MessageRow {
	id: number;
	message_id: string | null;
	direction: "in" | "out";
	issue_number: number | null;
	comment_id: number | null;
	r2_key: string | null;
	status: "pending" | "done" | "unknown";
	from_reporter: number;
	created_at: string;
}

export interface Thread {
	issueNumber: number;
	rootMessageId: string;
	subject: string;
	reporter: Address;
	extraRecipients: Address[];
	lastMessageId: string | null;
	lastReporterMessageId: string | null;
	refs: string[];
	closedAt: string | null;
	spam: boolean;
	filesDeletedAt: string | null;
}

interface ThreadRow {
	issue_number: number;
	root_message_id: string;
	subject: string;
	reporter_address: string;
	reporter_name: string;
	extra_recipients: string;
	last_message_id: string | null;
	last_reporter_message_id: string | null;
	refs: string;
	closed_at: string | null;
	spam: number;
	files_deleted_at: string | null;
}

const MAX_REFS = 30;

function parseJson<T>(value: string, fallback: T): T {
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

function toThread(row: ThreadRow): Thread {
	return {
		issueNumber: row.issue_number,
		rootMessageId: row.root_message_id,
		subject: row.subject,
		reporter: { address: row.reporter_address, name: row.reporter_name },
		extraRecipients: parseJson<Address[]>(row.extra_recipients, []),
		lastMessageId: row.last_message_id,
		lastReporterMessageId: row.last_reporter_message_id,
		refs: parseJson<string[]>(row.refs, []),
		closedAt: row.closed_at,
		spam: 1 === row.spam,
		filesDeletedAt: row.files_deleted_at,
	};
}

export class Store {
	constructor(private readonly db: D1Database) {}

	async getMessage(messageId: string): Promise<MessageRow | null> {
		return this.db.prepare("SELECT * FROM messages WHERE message_id = ?").bind(messageId).first<MessageRow>();
	}

	// The issue of the first id that is known, in the order given.
	async findIssue(messageIds: string[]): Promise<number | null> {
		const ids = [...new Set(messageIds)].slice(0, 50);
		if (0 === ids.length) {
			return null;
		}
		const { results } = await this.db
			.prepare(`SELECT message_id, issue_number FROM messages WHERE issue_number IS NOT NULL AND message_id IN (${ids.map(() => "?").join(", ")})`)
			.bind(...ids)
			.all<{ message_id: string; issue_number: number }>();
		const byId = new Map(results.map((row) => [row.message_id, row.issue_number]));
		for (const id of ids) {
			const issue = byId.get(id);
			if (undefined !== issue) {
				return issue;
			}
		}

		return null;
	}

	// The issue of one of our own emails, for direct replies.
	async findOutboundIssue(messageIds: string[]): Promise<number | null> {
		const ids = [...new Set(messageIds)].slice(0, 50);
		if (0 === ids.length) {
			return null;
		}
		const row = await this.db
			.prepare(`SELECT issue_number FROM messages WHERE direction = 'out' AND status = 'done' AND message_id IN (${ids.map(() => "?").join(", ")}) LIMIT 1`)
			.bind(...ids)
			.first<{ issue_number: number }>();

		return row?.issue_number ?? null;
	}

	async claimInbound(messageId: string, issueNumber: number | null, r2Key: string, fromReporter: boolean, now: string): Promise<void> {
		await this.db
			.prepare("INSERT INTO messages (message_id, direction, issue_number, r2_key, status, from_reporter, created_at) VALUES (?, 'in', ?, ?, 'pending', ?, ?) ON CONFLICT (message_id) DO NOTHING")
			.bind(messageId, issueNumber, r2Key, fromReporter ? 1 : 0, now)
			.run();
	}

	async updateInbound(messageId: string, fields: { issueNumber?: number; commentId?: number | null; status?: "pending" | "done"; fromReporter?: boolean }): Promise<void> {
		const sets: string[] = [];
		const values: (string | number | null)[] = [];
		if (undefined !== fields.issueNumber) {
			sets.push("issue_number = ?");
			values.push(fields.issueNumber);
		}
		if (undefined !== fields.commentId) {
			sets.push("comment_id = ?");
			values.push(fields.commentId);
		}
		if (undefined !== fields.status) {
			sets.push("status = ?");
			values.push(fields.status);
		}
		if (undefined !== fields.fromReporter) {
			sets.push("from_reporter = ?");
			values.push(fields.fromReporter ? 1 : 0);
		}
		if (sets.length > 0) {
			await this.db.prepare(`UPDATE messages SET ${sets.join(", ")} WHERE message_id = ?`).bind(...values, messageId).run();
		}
	}

	async getOutbound(commentId: number): Promise<MessageRow | null> {
		return this.db.prepare("SELECT * FROM messages WHERE direction = 'out' AND comment_id = ?").bind(commentId).first<MessageRow>();
	}

	// Returns false when a row already exists for this comment.
	async claimOutbound(commentId: number, issueNumber: number, now: string): Promise<boolean> {
		const result = await this.db
			.prepare("INSERT INTO messages (direction, issue_number, comment_id, status, created_at) VALUES ('out', ?, ?, 'pending', ?) ON CONFLICT DO NOTHING")
			.bind(issueNumber, commentId, now)
			.run();

		return result.meta.changes > 0;
	}

	async setOutboundStatus(commentId: number, status: "pending" | "done" | "unknown", messageId?: string): Promise<void> {
		if (undefined === messageId) {
			await this.db.prepare("UPDATE messages SET status = ? WHERE direction = 'out' AND comment_id = ?").bind(status, commentId).run();
		} else {
			await this.db.prepare("UPDATE messages SET status = ?, message_id = ? WHERE direction = 'out' AND comment_id = ?").bind(status, messageId, commentId).run();
		}
	}

	async releaseOutbound(commentId: number): Promise<void> {
		await this.db.prepare("DELETE FROM messages WHERE direction = 'out' AND comment_id = ? AND status != 'done'").bind(commentId).run();
	}

	async isMirroredComment(commentId: number): Promise<boolean> {
		return null !== (await this.db.prepare("SELECT id FROM messages WHERE direction = 'in' AND comment_id = ?").bind(commentId).first());
	}

	async listInbound(issueNumber: number): Promise<MessageRow[]> {
		const { results } = await this.db
			.prepare("SELECT * FROM messages WHERE direction = 'in' AND issue_number = ? AND r2_key IS NOT NULL ORDER BY id")
			.bind(issueNumber)
			.all<MessageRow>();

		return results;
	}

	async getThread(issueNumber: number): Promise<Thread | null> {
		const row = await this.db.prepare("SELECT * FROM threads WHERE issue_number = ?").bind(issueNumber).first<ThreadRow>();

		return null === row ? null : toThread(row);
	}

	async createThread(thread: { issueNumber: number; rootMessageId: string; subject: string; reporter: Address; extraRecipients: Address[] }, now: string): Promise<void> {
		await this.db
			.prepare("INSERT INTO threads (issue_number, root_message_id, subject, reporter_address, reporter_name, extra_recipients, last_message_id, last_reporter_message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (issue_number) DO NOTHING")
			.bind(thread.issueNumber, thread.rootMessageId, thread.subject, thread.reporter.address, thread.reporter.name, JSON.stringify(thread.extraRecipients), thread.rootMessageId, thread.rootMessageId, now)
			.run();
	}

	async addToThread(thread: Thread, messageId: string, fromReporter: boolean, extraRecipients?: Address[]): Promise<void> {
		const refs = thread.refs.includes(messageId) || messageId === thread.rootMessageId ? thread.refs : [...thread.refs, messageId].slice(-MAX_REFS);
		await this.db
			.prepare("UPDATE threads SET last_message_id = ?, last_reporter_message_id = ?, refs = ?, extra_recipients = ? WHERE issue_number = ?")
			.bind(messageId, fromReporter ? messageId : thread.lastReporterMessageId, JSON.stringify(refs), JSON.stringify(extraRecipients ?? thread.extraRecipients), thread.issueNumber)
			.run();
	}

	async setReporter(issueNumber: number, reporter: Address, extraRecipients: Address[]): Promise<void> {
		await this.db
			.prepare("UPDATE threads SET reporter_address = ?, reporter_name = ?, extra_recipients = ? WHERE issue_number = ?")
			.bind(reporter.address, reporter.name, JSON.stringify(extraRecipients), issueNumber)
			.run();
	}

	async setClosed(issueNumber: number, closedAt: string | null): Promise<void> {
		await this.db.prepare("UPDATE threads SET closed_at = ? WHERE issue_number = ?").bind(closedAt, issueNumber).run();
	}

	async setSpam(issueNumber: number): Promise<void> {
		await this.db.prepare("UPDATE threads SET spam = 1 WHERE issue_number = ?").bind(issueNumber).run();
	}

	// Threads closed before the cutoff whose files were not deleted since they were closed.
	async threadsToPurge(cutoff: string, limit: number): Promise<number[]> {
		const { results } = await this.db
			.prepare("SELECT issue_number FROM threads WHERE closed_at IS NOT NULL AND closed_at < ? AND (files_deleted_at IS NULL OR files_deleted_at < closed_at) ORDER BY closed_at LIMIT ?")
			.bind(cutoff, limit)
			.all<{ issue_number: number }>();

		return results.map((row) => row.issue_number);
	}

	async markFilesDeleted(issueNumber: number, now: string): Promise<void> {
		await this.db.prepare("UPDATE threads SET files_deleted_at = ? WHERE issue_number = ?").bind(now, issueNumber).run();
	}
}
