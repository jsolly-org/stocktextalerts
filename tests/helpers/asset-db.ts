import { Client } from "pg";

/**
 * Asset fixture writes via a direct `pg` connection (postgres role).
 *
 * Hosted production grants `service_role` only SELECT/UPDATE on
 * `public.assets` (reference data is owner-managed), and local mirrors that
 * since the tighten-table-privileges migration — so test fixtures cannot
 * seed or remove assets through `adminClient`. Fixture setup/teardown is a
 * postgres-owner concern, same as `tests/setup.ts` cleanup and the seed SQL.
 */

type AssetFixture = {
	symbol: string;
	name: string;
	type: string;
	delisted_at?: string;
	icon_url?: string | null;
	icon_checked_at?: string | null;
	icon_base64?: string | null;
	reference_updated_utc?: string | null;
};

/**
 * `assets` is shared across Vitest workers, so two fixture statements can lock overlapping
 * rows in different orders and Postgres kills one side as the deadlock victim (`40P01`).
 *
 * The one that actually produced this on CI (job 91724627441, `icon-check.test.ts` next to
 * `schedule/helpers.test.ts`) was a table-wide `UPDATE public.assets ... WHERE
 * icon_checked_at IS NULL`, which locked every unchecked row against another file's
 * two-symbol `DELETE`. That statement is gone: it was a leftover from the removed nightly
 * icon drip, and every spec that ran it only ever read rows it seeded itself. What remains
 * here writes only the caller's symbols.
 *
 * The retry stays as the net for the overlap that is still possible (two files touching
 * intersecting symbol sets). A deadlock victim only needs to try again, since the winner
 * has already committed by the time the error surfaces, and every statement below is a
 * single idempotent statement. Serialization failures (`40001`) get the same treatment.
 */
const RETRYABLE_PG_CODES = new Set(["40P01", "40001"]);
const MAX_PG_ATTEMPTS = 5;

function isRetryablePgError(err: unknown): boolean {
	const code = (err as { code?: unknown } | null | undefined)?.code;
	return typeof code === "string" && RETRYABLE_PG_CODES.has(code);
}

async function withPgClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) {
		throw new Error("Missing DATABASE_URL");
	}
	for (let attempt = 1; ; attempt++) {
		const client = new Client({ connectionString: databaseUrl });
		await client.connect();
		try {
			return await run(client);
		} catch (err) {
			if (attempt >= MAX_PG_ATTEMPTS || !isRetryablePgError(err)) throw err;
		} finally {
			await client.end();
		}
		// Jittered backoff so both sides of a deadlock do not re-collide immediately.
		await new Promise((resolve) => setTimeout(resolve, 25 * attempt + Math.random() * 25));
	}
}

export async function upsertAssets(records: AssetFixture[]): Promise<void> {
	if (records.length === 0) return;
	await withPgClient(async (client) => {
		await client.query(
			`
				INSERT INTO public.assets (
					symbol, name, type, delisted_at, icon_url, icon_checked_at,
					icon_base64, reference_updated_utc
				)
				SELECT symbol, name, type::public.asset_type, delisted_at, icon_url, icon_checked_at,
				       icon_base64, reference_updated_utc
				FROM jsonb_to_recordset($1::jsonb)
					AS r(symbol text, name text, type text, delisted_at timestamptz,
					     icon_url text, icon_checked_at timestamptz,
					     icon_base64 text, reference_updated_utc timestamptz)
				ON CONFLICT (symbol) DO UPDATE
					SET name = EXCLUDED.name,
					    type = EXCLUDED.type,
					    -- Preserve existing values when the caller omits a column
					    -- (parity with the old PostgREST upsert, which only wrote
					    -- payload columns); re-seeding a symbol must not un-delist it
					    -- or wipe its icon state.
					    delisted_at = COALESCE(EXCLUDED.delisted_at, public.assets.delisted_at),
					    icon_url = COALESCE(EXCLUDED.icon_url, public.assets.icon_url),
					    icon_checked_at = COALESCE(EXCLUDED.icon_checked_at, public.assets.icon_checked_at),
					    icon_base64 = COALESCE(EXCLUDED.icon_base64, public.assets.icon_base64),
					    reference_updated_utc = COALESCE(
					      EXCLUDED.reference_updated_utc, public.assets.reference_updated_utc
					    )
			`,
			[JSON.stringify(records)],
		);
	});
}

export async function deleteAssets(symbols: string[]): Promise<void> {
	if (symbols.length === 0) return;
	await withPgClient(async (client) => {
		await client.query(`DELETE FROM public.assets WHERE symbol = ANY($1::text[])`, [symbols]);
	});
}
