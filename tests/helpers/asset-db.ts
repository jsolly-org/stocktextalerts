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
 * `assets` is shared across Vitest workers, and these fixture statements lock
 * overlapping rows in different orders: `markAllAssetIconsChecked()` locks every
 * unchecked row in physical order while another file's `deleteAssets()` locks its
 * own two symbols, so Postgres can pick either side as the deadlock victim
 * (`40P01`, seen on CI job 91724627441 with `tests/lib/assets/icon-check.test.ts`
 * and `tests/lib/schedule/helpers.test.ts` running side by side).
 *
 * A deadlock victim only needs to try again — the winner has already committed by
 * the time the error surfaces — and every statement below is a single idempotent
 * statement, so the retry is safe. Serialization failures (`40001`) get the same
 * treatment for the same reason.
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

/**
 * Stamp `icon_checked_at` on every currently-unchecked `assets` row, so only
 * fixtures a test seeds afterwards (with a NULL `icon_checked_at`) qualify as
 * icon-backfill candidates. Without this, the ~10k-row seed universe (all
 * unchecked, sorting before Z-prefixed fixtures) fills PostgREST's max_rows-
 * clamped probe window and fixture symbols are never selected.
 */
export async function markAllAssetIconsChecked(): Promise<void> {
	await withPgClient(async (client) => {
		await client.query(
			`UPDATE public.assets SET icon_checked_at = now() WHERE icon_checked_at IS NULL`,
		);
	});
}

export async function deleteAssets(symbols: string[]): Promise<void> {
	if (symbols.length === 0) return;
	await withPgClient(async (client) => {
		await client.query(`DELETE FROM public.assets WHERE symbol = ANY($1::text[])`, [symbols]);
	});
}
