import type { App } from "../app";
import { hmacHex, timingSafeEqual } from "../crypto";
import { parseCommand } from "./commands";

interface WebhookPayload {
	action?: string;
	repository?: { full_name?: string };
	installation?: { id?: number };
	issue?: { number?: number; closed_at?: string | null };
	comment?: { id?: number; body?: string; user?: { type?: string } };
	sender?: { type?: string };
}

function response(status: number, text: string): Response {
	return new Response(text, { status });
}

export async function handleWebhook(request: Request, app: App): Promise<Response> {
	const { cfg } = app;
	if ("POST" !== request.method) {
		return response(405, "Method not allowed");
	}

	const body = await request.text();
	const expected = `sha256=${await hmacHex(cfg.webhookSecret, body)}`;
	if (!(await timingSafeEqual(request.headers.get("x-hub-signature-256") ?? "", expected))) {
		app.log("webhook_rejected", { reason: "signature" });

		return response(401, "Invalid signature");
	}

	let payload: WebhookPayload;
	try {
		payload = JSON.parse(body) as WebhookPayload;
	} catch {
		return response(400, "Invalid payload");
	}

	const event = request.headers.get("x-github-event") ?? "";
	const sameRepo = `${cfg.repoOwner}/${cfg.repoName}`.toLowerCase() === (payload.repository?.full_name ?? "").toLowerCase();
	const sameInstallation = String(payload.installation?.id ?? "") === cfg.installationId;
	const issue = payload.issue?.number;
	if (!sameRepo || !sameInstallation || "number" !== typeof issue) {
		return response(202, "Ignored");
	}

	if ("issues" === event && ("closed" === payload.action || "reopened" === payload.action)) {
		const closedAt = "closed" === payload.action ? payload.issue?.closed_at ?? app.now().toISOString() : null;
		await app.outboundQueue.send({ type: "issue_state", issue, closedAt });

		return response(202, "Queued");
	}

	if ("issue_comment" === event && "created" === payload.action && "number" === typeof payload.comment?.id) {
		// The App's own comments are the mirrored emails: they are never commands
		if ("Bot" === payload.comment.user?.type || "Bot" === payload.sender?.type) {
			return response(202, "Ignored");
		}
		if ("reply" !== cfg.defaultOutboundMode && null === parseCommand(payload.comment.body ?? "", cfg.commandPrefix)) {
			return response(202, "Ignored");
		}
		await app.outboundQueue.send({ type: "comment", issue, commentId: payload.comment.id, origin: new URL(request.url).origin });

		return response(202, "Queued");
	}

	return response(202, "Ignored");
}
