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
				INSERT INTO public.assets (symbol, name, type, delisted_at)
				SELECT symbol, name, type::public.asset_type, delisted_at
				FROM jsonb_to_recordset($1::jsonb)
					AS r(symbol text, name text, type text, delisted_at timestamptz)
				ON CONFLICT (symbol) DO UPDATE
					SET name = EXCLUDED.name,
					    type = EXCLUDED.type,
					    -- Preserve an existing delisted_at when the caller omits it
					    -- (parity with the old PostgREST upsert, which only wrote
					    -- payload columns); re-seeding a symbol must not un-delist it.
					    delisted_at = COALESCE(EXCLUDED.delisted_at, public.assets.delisted_at)
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
