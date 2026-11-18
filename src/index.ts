import { type App, logger } from "./app";
import { loadConfig } from "./config";
import { handleDownload } from "./download";
import type { Env } from "./env";
import { GitHubClient } from "./github/client";
import { GitHubError } from "./github/types";
import { processInbound } from "./inbound/consumer";
import { handleEmail } from "./inbound/email";
import { backoff, type InboundJob, type JobResult, type OutboundJob, retryIn } from "./jobs";
import { CloudflareMailer } from "./mailer";
import { processOutbound } from "./outbound/consumer";
import { handleWebhook } from "./outbound/webhook";
import { runRetention } from "./retention";
import { Store } from "./store";

export function createApp(env: Env): App {
	const cfg = loadConfig(env);

	return {
		cfg,
		store: new Store(env.DB),
		raw: env.RAW,
		github: new GitHubClient(cfg),
		mailer: new CloudflareMailer(env.EMAIL),
		inboundQueue: { send: (job) => env.INBOUND_QUEUE.send(job) },
		outboundQueue: { send: (job) => env.OUTBOUND_QUEUE.send(job) },
		now: () => new Date(),
		log: logger,
	};
}

async function run(job: InboundJob | OutboundJob, attempts: number, app: App): Promise<JobResult> {
	try {
		return "email" === job.type ? await processInbound(job, attempts, app) : await processOutbound(job, attempts, app);
	} catch (error) {
		// Whatever failed, the Queue retries, then moves the job to its dead-letter queue
		const transient = error instanceof GitHubError && error.transient;
		app.log("job_failed", { type: job.type, attempts, transient, status: error instanceof GitHubError ? error.status : null });

		return retryIn(transient && null !== error.retryAfter ? error.retryAfter : backoff(attempts));
	}
}

export default {
	async email(message, env): Promise<void> {
		await handleEmail(message, createApp(env));
	},

	async fetch(request, env): Promise<Response> {
		const { pathname } = new URL(request.url);
		if ("/github/webhook" === pathname) {
			return handleWebhook(request, createApp(env));
		}
		if (pathname.startsWith("/download/")) {
			return handleDownload(request, pathname.slice("/download/".length), createApp(env));
		}

		return new Response("Not found", { status: 404 });
	},

	async queue(batch, env): Promise<void> {
		const app = createApp(env);
		for (const message of batch.messages) {
			const result = await run(message.body, message.attempts, app);
			if ("ack" === result.action) {
				message.ack();
			} else {
				message.retry({ delaySeconds: result.delaySeconds });
			}
		}
	},

	async scheduled(_controller, env): Promise<void> {
		await runRetention(createApp(env));
	},
} satisfies ExportedHandler<Env, InboundJob | OutboundJob>;
