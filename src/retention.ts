import { type App, attachmentPrefix } from "./app";

const THREADS_PER_RUN = 25;

async function deleteFiles(r2Key: string, app: App): Promise<void> {
	const keys = [r2Key];
	let cursor: string | undefined;
	do {
		const listed = await app.raw.list({ prefix: attachmentPrefix(r2Key), cursor });
		keys.push(...listed.objects.map((object) => object.key));
		cursor = listed.truncated ? listed.cursor : undefined;
	} while (undefined !== cursor);
	await app.raw.delete(keys);
}

// Deletes the raw messages and the attachments of threads whose issue has been closed
// for longer than the retention. The D1 rows stay: a late reply still needs them.
export async function runRetention(app: App): Promise<number> {
	const { cfg, store } = app;
	if (null === cfg.retentionDays || "closed" !== cfg.retentionFrom) {
		return 0;
	}

	const now = app.now();
	const cutoff = new Date(now.getTime() - cfg.retentionDays * 86_400_000).toISOString();
	const issues = await store.threadsToPurge(cutoff, THREADS_PER_RUN);
	for (const issue of issues) {
		for (const row of await store.listInbound(issue)) {
			await deleteFiles(row.r2_key!, app);
		}
		await store.markFilesDeleted(issue, now.toISOString());
	}
	app.log("retention", { threads: issues.length });

	return issues.length;
}
