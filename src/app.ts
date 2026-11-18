import type { Address } from "./addresses";
import type { Config } from "./config";
import { hashId } from "./crypto";
import type { GitHub } from "./github/types";
import type { InboundJob, OutboundJob } from "./jobs";
import type { Store } from "./store";

export interface OutgoingEmail {
	to: Address;
	cc: Address[];
	from: Address;
	replyTo: string;
	subject: string;
	text: string;
	html: string;
	headers: Record<string, string>;
	attachments: { filename: string; type: string; content: Uint8Array }[];
}

export interface Mailer {
	// Returns the Message-ID that the email service generated, without angle brackets.
	send(mail: OutgoingEmail): Promise<string>;
}

export class MailError extends Error {
	constructor(
		readonly code: string,
		readonly transient: boolean,
	) {
		super(`The email service refused the message (${code})`);
	}
}

export interface JobQueue<T> {
	send(job: T): Promise<unknown>;
}

export interface App {
	cfg: Config;
	store: Store;
	raw: R2Bucket;
	github: GitHub;
	mailer: Mailer;
	inboundQueue: JobQueue<InboundJob>;
	outboundQueue: JobQueue<OutboundJob>;
	now: () => Date;
	log: (event: string, fields?: Record<string, string | number | boolean | null>) => void;
}

// Logs carry outcomes and hashes of ids, never subjects, bodies, addresses or file names.
export function logger(event: string, fields: Record<string, string | number | boolean | null> = {}): void {
	console.log(JSON.stringify({ event, ...fields }));
}

export async function ref(id: string | number): Promise<string> {
	return (await hashId(String(id))).slice(0, 12);
}

export function attachmentPrefix(r2Key: string): string {
	return `att/${r2Key.replace(/^.*\//, "").replace(/\.eml$/, "")}/`;
}
