import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach } from "vitest";

// Every test starts with an empty database and an empty bucket.
beforeEach(async () => {
	await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
	await env.DB.batch(["messages", "threads", "ignored_messages"].map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
	for (;;) {
		const { objects } = await env.RAW.list();
		if (0 === objects.length) {
			break;
		}
		await env.RAW.delete(objects.map((object) => object.key));
	}
});
