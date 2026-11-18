import type { App } from "./app";

// Where the conversation with the reporter stands:
// - to_acknowledge: the reporter wrote and nothing was sent to them yet;
// - to_reply: the reporter wrote after we answered;
// - waiting: we wrote last;
// - none: no label, for threads that need no answer.
export type ReportStatus = "to_acknowledge" | "to_reply" | "waiting" | "none";

export function statusLabel(status: ReportStatus, app: App): string {
	const { cfg } = app;
	switch (status) {
		case "to_acknowledge":
			// Without a label of its own, a new report is one that needs a reply
			return cfg.labelToAcknowledge || cfg.labelAwaitingReply;
		case "to_reply":
			return cfg.labelAwaitingReply;
		case "waiting":
			return cfg.labelAwaitingReporter;
		case "none":
			return "";
	}
}

// Ends the tracking of a thread: no status, and no answer is owed anymore.
export async function clearReportLabels(issue: number, app: App): Promise<void> {
	await setReportStatus(issue, "none", app);
	if ("" !== app.cfg.labelAnswerOwed) {
		await app.github.removeLabel(issue, app.cfg.labelAnswerOwed);
	}
}

// Puts the label of the status on the issue and removes the labels of the other statuses.
export async function setReportStatus(issue: number, status: ReportStatus, app: App): Promise<void> {
	const { cfg, github } = app;
	const wanted = statusLabel(status, app);
	for (const label of new Set([cfg.labelToAcknowledge, cfg.labelAwaitingReply, cfg.labelAwaitingReporter])) {
		if ("" !== label && label !== wanted) {
			await github.removeLabel(issue, label);
		}
	}
	if ("" !== wanted) {
		await github.ensureLabel(wanted);
		await github.addLabels(issue, [wanted]);
	}
}
