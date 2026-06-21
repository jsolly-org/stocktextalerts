/**
 * Integration tests for the daily ticker-universe reconcile.
 *
 * Uses real local Supabase (via the service-role `adminClient`, which the reconcile
 * itself writes through) + a fully STUBBED Massive provider via the module's
 * injection seams (`getActiveTickers`, `getTickerDetail`, `enqueueWarmup`) — no
 * network, no live provider keys.
 *
 * Asset fixture seeding goes through a direct `pg` connection (postgres owner),
 * mirroring `tests/helpers/asset-db.ts`: production grants `service_role` only
 * SELECT/UPDATE/INSERT on `public.assets`, but seeding pre-existing rows with the
 * richer columns (sector/icon_url/reference_updated_utc/composite_figi/delisted_at)
 * is an owner concern. Test symbols use a `Z`-prefix + per-file random suffix so
 * they never collide with real tickers or with parallel/future tests.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runUniverseReconcile } from "../../../src/lib/assets/universe-reconcile";
import { rootLogger } from "../../../src/lib/logging";
import type { ActiveTicker } from "../../../src/lib/providers/massive";
import { deleteAssets } from "../../helpers/asset-db";
import { adminClient } from "../../helpers/test-env";
import { createTestUser } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

/**
 * Unique test symbol prefix (max 10 chars, alphanumeric uppercase). `Z` prefix
 * keeps us out of real-ticker space; the random suffix avoids collisions.
 */
const TEST_PREFIX = `Z${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;

type TickerDetail = { ok: boolean; iconUrl: string | null; sector: string | null };

/** A pre-existing `assets` row to seed before a reconcile run. */
type SeedAsset = {
	symbol: string;
	name: string;
	type: "stock" | "etf";
	delisted_at?: string | null;
	sector?: string | null;
	icon_url?: string | null;
	reference_updated_utc?: string | null;
	composite_figi?: string | null;
};

async function withPgClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) throw new Error("Missing DATABASE_URL");
	const client = new Client({ connectionString: databaseUrl });
	await client.connect();
	try {
		return await run(client);
	} finally {
		await client.end();
	}
}

/**
 * Seed pre-existing `assets` rows with the full reconcile-relevant column set via
 * the postgres owner. `upsertAssets` in tests/helpers only covers
 * symbol/name/type/delisted_at, so we need this richer insert for the enrichment
 * and reappearance fixtures.
 */
async function seedAssets(records: SeedAsset[]): Promise<void> {
	if (records.length === 0) return;
	await withPgClient(async (client) => {
		await client.query(
			`
				INSERT INTO public.assets
					(symbol, name, type, delisted_at, sector, icon_url, reference_updated_utc, composite_figi)
				SELECT symbol, name, type, delisted_at, sector, icon_url, reference_updated_utc, composite_figi
				FROM jsonb_to_recordset($1::jsonb) AS r(
					symbol text, name text, type text, delisted_at timestamptz,
					sector text, icon_url text, reference_updated_utc timestamptz, composite_figi text
				)
				ON CONFLICT (symbol) DO UPDATE SET
					name = EXCLUDED.name,
					type = EXCLUDED.type,
					delisted_at = EXCLUDED.delisted_at,
					sector = EXCLUDED.sector,
					icon_url = EXCLUDED.icon_url,
					reference_updated_utc = EXCLUDED.reference_updated_utc,
					composite_figi = EXCLUDED.composite_figi
			`,
			[
				JSON.stringify(
					records.map((r) => ({
						symbol: r.symbol,
						name: r.name,
						type: r.type,
						delisted_at: r.delisted_at ?? null,
						sector: r.sector ?? null,
						icon_url: r.icon_url ?? null,
						reference_updated_utc: r.reference_updated_utc ?? null,
						composite_figi: r.composite_figi ?? null,
					})),
				),
			],
		);
	});
}

async function getAsset(symbol: string) {
	const { data } = await adminClient
		.from("assets")
		.select(
			"symbol, name, type, delisted_at, sector, icon_url, reference_updated_utc, composite_figi",
		)
		.eq("symbol", symbol)
		.maybeSingle();
	return data;
}

async function attachUserAsset(userId: string, symbol: string): Promise<void> {
	const { error } = await adminClient.from("user_assets").insert({ user_id: userId, symbol });
	if (error) throw new Error(`attachUserAsset failed: ${error.message}`);
}

/** Build a fake `getActiveTickers` seam returning a fixed active set. */
function fakeActiveTickers(tickers: ActiveTicker[]): () => Promise<ActiveTicker[]> {
	return async () => tickers;
}

/** Load every symbol+name in `assets`, paginated past the PostgREST 1000-row cap. */
async function allStoredAssets(): Promise<Array<{ symbol: string; name: string; type: string }>> {
	const rows: Array<{ symbol: string; name: string; type: string }> = [];
	const pageSize = 1000;
	for (let from = 0; ; from += pageSize) {
		const { data, error } = await adminClient
			.from("assets")
			.select("symbol, name, type")
			.order("symbol", { ascending: true })
			.range(from, from + pageSize - 1);
		if (error) throw error;
		const page = data ?? [];
		for (const r of page) rows.push(r);
		if (page.length < pageSize) break;
	}
	return rows;
}

/**
 * Build an active set that keeps the *entire current seed universe* "active" except
 * for `excludedSymbols`. This both mirrors production (Massive's active set ≈ the full
 * universe) and is essential for test isolation: step 3 flags every untracked stored
 * symbol absent from the active set, so a tiny fake active set would stamp delisted_at
 * on ~10k shared seed rows and poison other tests. Keeping the seed universe in the
 * active set confines the delist-flag to the symbols we deliberately exclude.
 *
 * Real names/types are preserved so step 2's upsert is a no-op on the seed rows (no
 * mass-rename). Callers should pass `enrichmentCap: 0` so seed rows aren't enriched.
 */
async function activeSetCoveringSeedExcept(excludedSymbols: string[]): Promise<ActiveTicker[]> {
	const excluded = new Set(excludedSymbols);
	const stored = await allStoredAssets();
	return stored
		.filter((r) => !excluded.has(r.symbol))
		.map((r) =>
			makeActiveTicker({
				symbol: r.symbol,
				name: r.name,
				type: r.type === "etf" ? "etf" : "stock",
			}),
		);
}

/**
 * Active set for the enrichment tests: the test's own `targets` come FIRST, then the
 * whole seed universe (minus the targets, so step 2 doesn't duplicate them). Targets-
 * first matters because the module enriches `candidates.slice(0, cap)` in array order:
 * with the target at the front and `enrichmentCap: targets.length`, exactly the target
 * symbols are detail-fetched while the (also-candidate, because unenriched) seed rows
 * spill past the cap and are skipped — so enrichment writes never touch seed data.
 */
async function activeSetTargetsFirst(targets: ActiveTicker[]): Promise<ActiveTicker[]> {
	const targetSymbols = targets.map((t) => t.symbol);
	const seed = await activeSetCoveringSeedExcept(targetSymbols);
	return [...targets, ...seed];
}

function makeActiveTicker(overrides: Partial<ActiveTicker> & { symbol: string }): ActiveTicker {
	return {
		name: `Active ${overrides.symbol}`,
		type: "stock",
		lastUpdatedUtc: "2026-06-20T00:00:00Z",
		compositeFigi: null,
		...overrides,
	};
}

/**
 * Build a fake `getTickerDetail` seam that records which symbols it was asked
 * about and returns a per-symbol detail (default: a healthy stock detail).
 */
function makeFakeDetail(bySymbol?: Map<string, TickerDetail>): {
	fn: (symbol: string) => Promise<TickerDetail>;
	calls: string[];
} {
	const calls: string[] = [];
	const fn = async (symbol: string): Promise<TickerDetail> => {
		calls.push(symbol);
		return (
			bySymbol?.get(symbol) ?? {
				ok: true,
				iconUrl: `https://cdn.example.com/${symbol}.png`,
				sector: "Technology",
			}
		);
	};
	return { fn, calls };
}

/** Build a fake `enqueueWarmup` seam that records the symbols it was handed. */
function makeFakeWarmup(): {
	fn: (msg: { symbol: string; reason?: string }) => Promise<boolean>;
	enqueued: Array<{ symbol: string; reason?: string }>;
} {
	const enqueued: Array<{ symbol: string; reason?: string }> = [];
	const fn = async (msg: { symbol: string; reason?: string }) => {
		enqueued.push(msg);
		return true;
	};
	return { fn, enqueued };
}

describe("runUniverseReconcile", () => {
	const createdSymbols: string[] = [];

	beforeEach(() => {
		createdSymbols.length = 0;
	});

	afterEach(async () => {
		// price_targets / user_assets FK assets(symbol); clear dependents first.
		for (const symbol of createdSymbols) {
			await adminClient
				.from("price_targets")
				.delete()
				.eq("symbol", symbol)
				.then(() => {});
			await adminClient
				.from("user_assets")
				.delete()
				.eq("symbol", symbol)
				.then(() => {});
		}
		await deleteAssets(createdSymbols).catch(() => {});
	});

	it("A new IPO listing in Massive's active set is inserted into assets with name + type, enriched, and queued for warmup.", async () => {
		const newSymbol = `${TEST_PREFIX}NEW`;
		createdSymbols.push(newSymbol);

		const detail = makeFakeDetail();
		const warmup = makeFakeWarmup();
		// Targets-first + cap 1 → only our new symbol is detail-fetched (seed rows
		// spill past the cap), and the seed-covering set keeps step 3 from flagging
		// the shared universe delisted.
		const active = await activeSetTargetsFirst([
			makeActiveTicker({
				symbol: newSymbol,
				name: "Freshly Listed Robotics Inc",
				type: "stock",
				lastUpdatedUtc: "2026-06-19T22:00:00Z",
				compositeFigi: "BBG00FRESH01",
			}),
		]);
		const result = await runUniverseReconcile({
			supabase: adminClient,
			logger: rootLogger,
			getActiveTickers: fakeActiveTickers(active),
			getTickerDetail: detail.fn,
			enqueueWarmup: warmup.fn,
			enrichmentCap: 1,
		});

		expect(result.providerFetchFailed).toBe(false);
		expect(result.newListingsInserted).toBe(1);

		const row = await getAsset(newSymbol);
		expect(row?.name).toBe("Freshly Listed Robotics Inc");
		expect(row?.type).toBe("stock");
		expect(row?.delisted_at).toBeNull();
		expect(row?.composite_figi).toBe("BBG00FRESH01");
		// reference_updated_utc persisted (timestamptz round-trips to +00:00 form).
		expect(row?.reference_updated_utc).toBe("2026-06-19T22:00:00+00:00");

		// New symbol is an enrichment candidate → detail fetched + written.
		expect(detail.calls).toContain(newSymbol);
		expect(result.enriched).toBe(1);
		expect(row?.icon_url).toBe(`https://cdn.example.com/${newSymbol}.png`);
		expect(row?.sector).toBe("Technology");

		// New symbol queued for price warmup.
		expect(result.warmupEnqueued).toBe(1);
		expect(warmup.enqueued).toContainEqual({
			symbol: newSymbol,
			reason: "universe_reconcile_new_listing",
		});
	});

	it("An existing symbol whose company name changed in Massive's set is updated, and is not re-queued for warmup.", async () => {
		const symbol = `${TEST_PREFIX}RNM`;
		createdSymbols.push(symbol);
		await seedAssets([
			{
				symbol,
				name: "Old Holdings Corp",
				type: "stock",
				sector: "Energy",
				icon_url: `https://cdn.example.com/${symbol}.png`,
				reference_updated_utc: "2026-06-01T00:00:00Z",
			},
		]);

		const detail = makeFakeDetail();
		const warmup = makeFakeWarmup();
		const active = await activeSetTargetsFirst([
			makeActiveTicker({
				symbol,
				name: "Rebranded Energy Partners LP",
				type: "stock",
				// Same reference timestamp → not an enrichment candidate via the advance
				// gate, and sector+icon already present → not via the missing-data gate.
				lastUpdatedUtc: "2026-06-01T00:00:00Z",
			}),
		]);
		const result = await runUniverseReconcile({
			supabase: adminClient,
			logger: rootLogger,
			getActiveTickers: fakeActiveTickers(active),
			getTickerDetail: detail.fn,
			enqueueWarmup: warmup.fn,
			enrichmentCap: 0,
		});

		expect(result.namesUpdated).toBe(1);
		const row = await getAsset(symbol);
		expect(row?.name).toBe("Rebranded Energy Partners LP");

		// Our already-listed symbol is not new → not warmed. (Seed rows already exist
		// too, so nothing in this run is a new listing.)
		expect(result.newListingsInserted).toBe(0);
		expect(result.warmupEnqueued).toBe(0);
		expect(warmup.enqueued).toHaveLength(0);
	});

	it("A previously-delisted symbol that reappears in the active set has its delisted_at cleared.", async () => {
		const symbol = `${TEST_PREFIX}RBN`;
		createdSymbols.push(symbol);
		await seedAssets([
			{
				symbol,
				name: "Relisted Manufacturing Co",
				type: "stock",
				delisted_at: "2026-03-15T00:00:00Z",
				sector: "Industrials",
				icon_url: `https://cdn.example.com/${symbol}.png`,
				reference_updated_utc: "2026-03-15T00:00:00Z",
			},
		]);

		// Sanity: it starts flagged.
		const before = await getAsset(symbol);
		expect(before?.delisted_at).not.toBeNull();

		// Seed-covering active set with our reappearing symbol included (it's active
		// again). cap 0 → the clear happens in step 2's upsert (delisted_at: null),
		// independent of enrichment.
		const active = await activeSetTargetsFirst([
			makeActiveTicker({
				symbol,
				name: "Relisted Manufacturing Co",
				type: "stock",
				lastUpdatedUtc: "2026-06-18T00:00:00Z",
			}),
		]);
		const result = await runUniverseReconcile({
			supabase: adminClient,
			logger: rootLogger,
			getActiveTickers: fakeActiveTickers(active),
			getTickerDetail: makeFakeDetail().fn,
			enqueueWarmup: makeFakeWarmup().fn,
			enrichmentCap: 0,
		});

		expect(result.delistedCleared).toBe(1);
		const after = await getAsset(symbol);
		expect(after?.delisted_at).toBeNull();
	});

	it("An UNtracked stored symbol absent from Massive's active set gets delisted_at stamped (drains the backlog).", async () => {
		const goneSymbol = `${TEST_PREFIX}GONE`;
		const stillActive = `${TEST_PREFIX}LIVE`;
		createdSymbols.push(goneSymbol, stillActive);
		await seedAssets([
			{ symbol: goneSymbol, name: "Defunct Untracked Inc", type: "stock" },
			{ symbol: stillActive, name: "Still Trading Inc", type: "stock" },
		]);

		// Active set = the whole seed universe + `stillActive`, but NOT `goneSymbol`.
		// Excluding only `goneSymbol` is what isolates the delist-flag to our row
		// instead of stamping the entire shared seed table delisted.
		const active = await activeSetCoveringSeedExcept([goneSymbol]);

		const result = await runUniverseReconcile({
			supabase: adminClient,
			logger: rootLogger,
			getActiveTickers: fakeActiveTickers(active),
			getTickerDetail: makeFakeDetail().fn,
			enqueueWarmup: makeFakeWarmup().fn,
			enrichmentCap: 0, // don't enrich (and mutate) thousands of seed rows
		});

		// Exactly our one untracked-absent symbol is newly flagged.
		expect(result.untrackedDelistedFlagged).toBe(1);
		const gone = await getAsset(goneSymbol);
		const live = await getAsset(stillActive);
		expect(gone?.delisted_at).not.toBeNull();
		expect(live?.delisted_at).toBeNull();
	});

	it("A TRACKED symbol absent from Massive's active set is NEVER flagged by reconcile (the safety carve-out).", async () => {
		const trackedGone = `${TEST_PREFIX}TRK`;
		const untrackedGone = `${TEST_PREFIX}UTRK`;
		createdSymbols.push(trackedGone, untrackedGone);
		await seedAssets([
			{ symbol: trackedGone, name: "User Holds This Co", type: "stock" },
			{ symbol: untrackedGone, name: "Nobody Holds This Co", type: "stock" },
		]);

		const user = await createTestUser({
			email: `reconcile-tracked-${randomUUID()}@example.com`,
			confirmed: true,
		});
		registerTestUserForCleanup(user.id);
		await attachUserAsset(user.id, trackedGone);

		// Active set covers the whole seed universe but EXCLUDES both our targets — so
		// both are "absent from Massive's active set", the exact delisting condition.
		// The carve-out must flag the untracked one and spare the tracked one.
		const active = await activeSetCoveringSeedExcept([trackedGone, untrackedGone]);

		const result = await runUniverseReconcile({
			supabase: adminClient,
			logger: rootLogger,
			getActiveTickers: fakeActiveTickers(active),
			getTickerDetail: makeFakeDetail().fn,
			enqueueWarmup: makeFakeWarmup().fn,
			enrichmentCap: 0,
		});

		// The carve-out: reconcile leaves delisted_at null on the TRACKED row...
		const tracked = await getAsset(trackedGone);
		expect(tracked?.delisted_at).toBeNull();
		// ...but DOES flag the otherwise-identical UNtracked row (proves the active set
		// really did mark both absent — so the tracked row's survival is the carve-out,
		// not just an active-set miss).
		const untracked = await getAsset(untrackedGone);
		expect(untracked?.delisted_at).not.toBeNull();
		expect(result.untrackedDelistedFlagged).toBe(1);
	});

	it("Enrichment gate: an unchanged last_updated_utc on a fully-enriched symbol triggers no detail call.", async () => {
		const symbol = `${TEST_PREFIX}STBL`;
		createdSymbols.push(symbol);
		await seedAssets([
			{
				symbol,
				name: "Stable Enriched Co",
				type: "stock",
				sector: "Healthcare",
				icon_url: `https://cdn.example.com/${symbol}.png`,
				reference_updated_utc: "2026-06-10T00:00:00Z",
			},
		]);

		const detail = makeFakeDetail();
		// Targets-first + cap 1: even if the (unenriched) seed rows are candidates and
		// one of them gets the single enrichment slot, our fully-enriched symbol must
		// NOT be a candidate at all — so it's never detail-fetched. We assert on our
		// symbol specifically, not a global count.
		const active = await activeSetTargetsFirst([
			makeActiveTicker({
				symbol,
				name: "Stable Enriched Co",
				type: "stock",
				// Same as stored → no advance; sector+icon present → no missing-data gate.
				lastUpdatedUtc: "2026-06-10T00:00:00Z",
			}),
		]);
		await runUniverseReconcile({
			supabase: adminClient,
			logger: rootLogger,
			getActiveTickers: fakeActiveTickers(active),
			getTickerDetail: detail.fn,
			enqueueWarmup: makeFakeWarmup().fn,
			enrichmentCap: 1,
		});

		// The load-bearing assertion: our already-enriched symbol was never a candidate,
		// so it was never detail-fetched and its enrichment is left untouched.
		expect(detail.calls).not.toContain(symbol);
		const row = await getAsset(symbol);
		expect(row?.sector).toBe("Healthcare");
		expect(row?.icon_url).toBe(`https://cdn.example.com/${symbol}.png`);
	});

	it("Enrichment gate: an advanced last_updated_utc on a stock triggers a detail call that updates sector + icon.", async () => {
		const symbol = `${TEST_PREFIX}ADV`;
		createdSymbols.push(symbol);
		await seedAssets([
			{
				symbol,
				name: "Advancing Reference Co",
				type: "stock",
				sector: "Energy",
				icon_url: `https://cdn.example.com/old-${symbol}.png`,
				reference_updated_utc: "2026-05-01T00:00:00Z",
			},
		]);

		const detail = makeFakeDetail(
			new Map([
				[
					symbol,
					{ ok: true, iconUrl: `https://cdn.example.com/new-${symbol}.png`, sector: "Financials" },
				],
			]),
		);
		// Target first + cap 1 → our advanced symbol takes the single enrichment slot.
		const active = await activeSetTargetsFirst([
			makeActiveTicker({
				symbol,
				name: "Advancing Reference Co",
				type: "stock",
				// Newer than the stored 2026-05-01 → advance gate fires.
				lastUpdatedUtc: "2026-06-15T00:00:00Z",
			}),
		]);
		const result = await runUniverseReconcile({
			supabase: adminClient,
			logger: rootLogger,
			getActiveTickers: fakeActiveTickers(active),
			getTickerDetail: detail.fn,
			enqueueWarmup: makeFakeWarmup().fn,
			enrichmentCap: 1,
		});

		expect(detail.calls).toContain(symbol);
		expect(result.enriched).toBe(1);
		const row = await getAsset(symbol);
		expect(row?.sector).toBe("Financials");
		expect(row?.icon_url).toBe(`https://cdn.example.com/new-${symbol}.png`);
		// Reference timestamp advanced to the incoming value.
		expect(row?.reference_updated_utc).toBe("2026-06-15T00:00:00+00:00");
	});

	it("Enrichment gate: an ETF is enriched for icon but never has a sector written (ETFs have no SIC code).", async () => {
		const etfSymbol = `${TEST_PREFIX}ETF`;
		createdSymbols.push(etfSymbol);
		// New ETF (no prior row) → enrichment candidate.

		// Even if the detail seam returns a sector, an ETF must not get it written.
		const detail = makeFakeDetail(
			new Map([
				[
					etfSymbol,
					{
						ok: true,
						iconUrl: `https://cdn.example.com/${etfSymbol}.png`,
						sector: "ShouldBeIgnored",
					},
				],
			]),
		);
		const active = await activeSetTargetsFirst([
			makeActiveTicker({
				symbol: etfSymbol,
				name: "Broad Market Index ETF",
				type: "etf",
				lastUpdatedUtc: "2026-06-19T00:00:00Z",
			}),
		]);
		const result = await runUniverseReconcile({
			supabase: adminClient,
			logger: rootLogger,
			getActiveTickers: fakeActiveTickers(active),
			getTickerDetail: detail.fn,
			enqueueWarmup: makeFakeWarmup().fn,
			enrichmentCap: 1,
		});

		expect(detail.calls).toContain(etfSymbol);
		expect(result.enriched).toBe(1);
		const row = await getAsset(etfSymbol);
		expect(row?.type).toBe("etf");
		expect(row?.icon_url).toBe(`https://cdn.example.com/${etfSymbol}.png`);
		// The carve-out: no sector for ETFs, even though the provider returned one.
		expect(row?.sector).toBeNull();
	});

	it("The per-run enrichment cap is respected: candidates beyond the cap are deferred, not detail-fetched.", async () => {
		const symbols = [
			`${TEST_PREFIX}C1`,
			`${TEST_PREFIX}C2`,
			`${TEST_PREFIX}C3`,
			`${TEST_PREFIX}C4`,
		];
		createdSymbols.push(...symbols);
		// All four are brand-new → all four are enrichment candidates. Placed FIRST in
		// the active set, so with cap 2 the module's `candidates.slice(0, cap)` (array
		// order) enriches exactly C1+C2 and defers C3+C4. We assert on our four symbols
		// only — the seed-covering tail keeps step 3 from flagging the shared universe,
		// but the seed rows are also unenriched candidates so the GLOBAL counters are
		// polluted; the per-symbol behavior below is the load-bearing proof.
		const active = await activeSetTargetsFirst(
			symbols.map((symbol) => makeActiveTicker({ symbol, name: `Capped Listing ${symbol}` })),
		);
		const detail = makeFakeDetail();
		await runUniverseReconcile({
			supabase: adminClient,
			logger: rootLogger,
			getActiveTickers: fakeActiveTickers(active),
			getTickerDetail: detail.fn,
			enqueueWarmup: makeFakeWarmup().fn,
			enrichmentCap: 2,
			enrichmentConcurrency: 2,
		});

		// The cap stops the run at exactly 2 detail fetches, in array order: C1, C2 are
		// fetched; C3, C4 are deferred to a future run.
		const myCalls = detail.calls.filter((s) => symbols.includes(s));
		expect(myCalls.sort()).toEqual([symbols[0], symbols[1]]);
		expect(detail.calls).not.toContain(symbols[2]);
		expect(detail.calls).not.toContain(symbols[3]);

		// All four rows were inserted (upsert is uncapped); only the first two enriched.
		const rows = await Promise.all(symbols.map((s) => getAsset(s)));
		expect(rows[0]?.icon_url).not.toBeNull();
		expect(rows[1]?.icon_url).not.toBeNull();
		expect(rows[2]?.icon_url).toBeNull();
		expect(rows[3]?.icon_url).toBeNull();
	});

	it("An empty active set (provider failure) aborts before any mutation — no stored symbol is flagged delisted.", async () => {
		const symbol = `${TEST_PREFIX}SAFE`;
		createdSymbols.push(symbol);
		await seedAssets([{ symbol, name: "Must Stay Listed Co", type: "stock" }]);

		const detail = makeFakeDetail();
		const warmup = makeFakeWarmup();
		const result = await runUniverseReconcile({
			supabase: adminClient,
			logger: rootLogger,
			// Empty set ⇒ treated as provider failure (a genuinely empty universe is impossible).
			getActiveTickers: fakeActiveTickers([]),
			getTickerDetail: detail.fn,
			enqueueWarmup: warmup.fn,
		});

		expect(result.providerFetchFailed).toBe(true);
		expect(result.untrackedDelistedFlagged).toBe(0);
		expect(result.activeTickersFetched).toBe(0);
		// No detail / warmup work happened.
		expect(detail.calls).toHaveLength(0);
		expect(warmup.enqueued).toHaveLength(0);
		// The stored row must NOT have been flagged — this is the catastrophic-failure guard.
		const row = await getAsset(symbol);
		expect(row?.delisted_at).toBeNull();
	});

	it("An enrichment provider miss (ok:false) leaves the row's existing sector + icon intact and counts as a failure, not an overwrite.", async () => {
		const symbol = `${TEST_PREFIX}MISS`;
		createdSymbols.push(symbol);
		await seedAssets([
			{
				symbol,
				name: "Provider Outage Co",
				type: "stock",
				sector: "Utilities",
				icon_url: `https://cdn.example.com/${symbol}.png`,
				reference_updated_utc: "2026-04-01T00:00:00Z",
			},
		]);

		// Detail seam reports a miss (Massive 5xx / not-found). The guarantee under test:
		// a miss must NOT null out the row's existing enrichment.
		const detail = makeFakeDetail(new Map([[symbol, { ok: false, iconUrl: null, sector: null }]]));
		// Advance the reference so the symbol qualifies as a candidate; target-first +
		// cap 1 → exactly this one detail call happens, so the counters are exact.
		const active = await activeSetTargetsFirst([
			makeActiveTicker({
				symbol,
				name: "Provider Outage Co",
				type: "stock",
				lastUpdatedUtc: "2026-06-16T00:00:00Z",
			}),
		]);
		const result = await runUniverseReconcile({
			supabase: adminClient,
			logger: rootLogger,
			getActiveTickers: fakeActiveTickers(active),
			getTickerDetail: detail.fn,
			enqueueWarmup: makeFakeWarmup().fn,
			enrichmentCap: 1,
		});

		expect(detail.calls).toContain(symbol);
		// Counted as a failure, nothing enriched, and the prior data stands untouched.
		expect(result.enriched).toBe(0);
		expect(result.enrichmentFailed).toBe(1);
		const row = await getAsset(symbol);
		expect(row?.sector).toBe("Utilities");
		expect(row?.icon_url).toBe(`https://cdn.example.com/${symbol}.png`);
	});

	it("One symbol's detail fetch throwing does not sink the batch — the healthy symbol is still enriched.", async () => {
		const throwSymbol = `${TEST_PREFIX}THRW`;
		const okSymbol = `${TEST_PREFIX}OKAY`;
		createdSymbols.push(throwSymbol, okSymbol);
		// Both brand-new → both enrichment candidates.

		const calls: string[] = [];
		const detailFn = async (symbol: string): Promise<TickerDetail> => {
			calls.push(symbol);
			if (symbol === throwSymbol) throw new Error("Massive detail timeout");
			return { ok: true, iconUrl: `https://cdn.example.com/${symbol}.png`, sector: "Technology" };
		};
		// Both targets first, cap 2, concurrency 2 → exactly these two run in one batch.
		const active = await activeSetTargetsFirst([
			makeActiveTicker({ symbol: throwSymbol, name: "Flaky Detail Co", type: "stock" }),
			makeActiveTicker({ symbol: okSymbol, name: "Healthy Detail Co", type: "stock" }),
		]);
		const result = await runUniverseReconcile({
			supabase: adminClient,
			logger: rootLogger,
			getActiveTickers: fakeActiveTickers(active),
			getTickerDetail: detailFn,
			enqueueWarmup: makeFakeWarmup().fn,
			enrichmentCap: 2,
			enrichmentConcurrency: 2,
		});

		// The throw is isolated per-symbol: failure counted, the healthy one still enriched.
		expect(calls).toContain(throwSymbol);
		expect(result.enrichmentFailed).toBe(1);
		expect(result.enriched).toBe(1);
		const healthy = await getAsset(okSymbol);
		expect(healthy?.icon_url).toBe(`https://cdn.example.com/${okSymbol}.png`);
		expect(healthy?.sector).toBe("Technology");
	});
});
