import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectOptionCatalogDrift } from "../../../scripts/db/check-option-catalog";
import { NOTIFICATION_PREFERENCE_CATALOG } from "../../../src/lib/constants";

/**
 * Locks the notification_options table to the authored option catalog
 * (NOTIFICATION_OPTION_MATRIX) and pins the drift checker's RED paths — CI
 * otherwise only ever exercises its green path via db:reset, so a regression
 * in the set-diff logic would leave the gate passing while guarding nothing.
 *
 * Complements `npm run check:option-catalog` (same core logic via
 * `collectOptionCatalogDrift`), mirroring the privileges.test.ts pattern.
 */

function createDbClient(): Client {
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) {
		throw new Error("Missing DATABASE_URL");
	}
	return new Client({ connectionString: databaseUrl });
}

describe("notification_options mirrors the authored option catalog", () => {
	let client: Client;

	beforeAll(async () => {
		client = createDbClient();
		await client.connect();
	});

	afterAll(async () => {
		await client.end();
	});

	it("the live table matches NOTIFICATION_OPTION_MATRIX exactly", async () => {
		expect(await collectOptionCatalogDrift(client)).toEqual([]);
	});

	it("reports drift in both directions (missing table row; off-catalog table row)", async () => {
		const rows = NOTIFICATION_PREFERENCE_CATALOG.map(({ notification_type, content, channel }) => ({
			notification_type,
			content,
			channel,
		}));
		const dropped = rows[0]!;
		const mutated = [
			...rows.slice(1),
			// price_move_alerts is facet-less (content ""), so "prices" is never a
			// valid content for it — an off-catalog straggler.
			{ notification_type: "price_move_alerts", content: "prices", channel: "telegram" },
		];
		const fakeClient = {
			query: async () => ({ rows: mutated }),
		} as unknown as Client;

		const errors = await collectOptionCatalogDrift(fakeClient);

		expect(errors).toHaveLength(2);
		expect(
			errors.some(
				(e) =>
					e.includes(`(${dropped.notification_type}|${dropped.content}|${dropped.channel})`) &&
					e.includes("has no notification_options row"),
			),
		).toBe(true);
		expect(
			errors.some(
				(e) =>
					e.includes("(price_move_alerts|prices|telegram)") &&
					e.includes("not in NOTIFICATION_OPTION_MATRIX"),
			),
		).toBe(true);
	});
});
