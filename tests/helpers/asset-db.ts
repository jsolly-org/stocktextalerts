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

async function withPgClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) {
		throw new Error("Missing DATABASE_URL");
	}
	const client = new Client({ connectionString: databaseUrl });
	await client.connect();
	try {
		return await run(client);
	} finally {
		await client.end();
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
