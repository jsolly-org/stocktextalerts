/**
 * Integration tests for the daily ticker-universe reconcile.
 *
 * Uses real local Supabase (via the service-role `adminClient`, which the reconcile
 * itself writes through) + a fully STUBBED Massive provider via vi.mock on the
 * universe module, plus a stubbed warmup enqueue — no network, no live provider keys.
 *
 * Asset fixture seeding goes through `upsertAssets` (direct `pg`, postgres owner) in
 * `tests/helpers/asset-db.ts`. Test symbols use a `Z`-prefix + per-file random suffix
 * so they never collide with real tickers or with parallel/future tests.
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchActiveTickersMock = vi.hoisted(() => vi.fn());
const enqueueNewSymbolWarmupMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/lib/assets/reference/universe", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../../src/lib/assets/reference/universe")>();
	return { ...actual, fetchActiveTickers: fetchActiveTickersMock };
});

vi.mock("../../../src/lib/vendors/backfill/enqueue", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/lib/vendors/backfill/enqueue")>();
	return { ...actual, enqueueNewSymbolWarmup: enqueueNewSymbolWarmupMock };
});

import type { ActiveTicker, ActiveUniverse } from "../../../src/lib/assets/types";
import { runUniverseReconcile } from "../../../src/lib/assets/universe-reconcile";
import { rootLogger } from "../../../src/lib/logging";
import { deleteAssets, upsertAssets } from "../../helpers/asset-db";
import { adminClient } from "../../helpers/test-env";
import { createTestUser } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";
import { expectConsoleError } from "../../setup";

/**
 * Unique test symbol prefix (max 10 chars, alphanumeric uppercase). `Z` prefix
 * keeps us out of real-ticker space; the random suffix avoids collisions.
 */
const TEST_PREFIX = `Z${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;

async function getAsset(symbol: string) {
	const { data } = await adminClient
		.from("assets")
		.select("symbol, name, type, delisted_at")
		.eq("symbol", symbol)
		.maybeSingle();
	return data;
}

async function attachUserAsset(userId: string, symbol: string): Promise<void> {
	const { error } = await adminClient.from("user_assets").insert({ user_id: userId, symbol });
	if (error) throw new Error(`attachUserAsset failed: ${error.message}`);
}

function makeActiveTicker(overrides: Partial<ActiveTicker> & { symbol: string }): ActiveTicker {
	return {
		name: `ACTIVE ${overrides.symbol} INC`,
		type: "stock",
		...overrides,
	};
}

/**
 * Assemble an `ActiveUniverse` from the insertable stock/etf subset plus symbols
 * Massive returned that failed insertion filters.
 */
function makeUniverse(
	tickers: ActiveTicker[],
	nonListedActiveSymbols: string[] = [],
): ActiveUniverse {
	return {
		tickers,
		allActiveSymbols: new Set([...tickers.map((t) => t.symbol), ...nonListedActiveSymbols]),
	};
}

/** Load every non-delisted symbol+name+type in `assets`, paginated past the PostgREST 1000-row cap. */
async function allActiveStoredAssets(): Promise<
	Array<{ symbol: string; name: string; type: string }>
> {
	const rows: Array<{ symbol: string; name: string; type: string }> = [];
	const pageSize = 1000;
	for (let from = 0; ; from += pageSize) {
		const { data, error } = await adminClient
			.from("assets")
			.select("symbol, name, type")
			.is("delisted_at", null)
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
 * Build a typed active set that keeps the *entire current non-delisted seed universe*
 * "active" except for `excludedSymbols`. This both mirrors production (the active set
 * ≈ the full universe, comfortably above MIN_PLAUSIBLE_ACTIVE_UNIVERSE) and is
 * essential for test isolation: step 3 flags every untracked stored symbol absent
 * from the active superset, so a tiny fake active set would stamp delisted_at on
 * ~10k shared seed rows and poison other tests. Keeping the seed universe in the
 * active set confines the delist-flag to the symbols we deliberately exclude.
 *
 * Already-delisted stored rows are NOT included: putting them in the superset would
 * make step 2 clear their `delisted_at` (a persistent mutation of shared seed state
 * and pollution of the `delistedCleared` counter), while leaving them out is safe —
 * step 3 only flags rows whose `delisted_at` is currently null.
 *
 * Step 2 never writes to these rows either: they all already exist in `assets`, so
 * none qualifies as a new listing (inserts use `ignoreDuplicates` and reconcile
 * only rewrites names when Massive returns a different value).
 */
async function activeSetCoveringSeedExcept(excludedSymbols: string[]): Promise<ActiveTicker[]> {
	const excluded = new Set(excludedSymbols);
	const stored = await allActiveStoredAssets();
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

/** Build a fake `enqueueNewSymbolWarmup` seam that records the symbols it was handed. */
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
		fetchActiveTickersMock.mockReset();
		enqueueNewSymbolWarmupMock.mockReset();
		enqueueNewSymbolWarmupMock.mockImplementation(makeFakeWarmup().fn);
		createdSymbols.length = 0;
	});

	afterEach(async () => {
		// user_assets FK assets(symbol); clear dependents first.
		for (const symbol of createdSymbols) {
			await adminClient
				.from("user_assets")
				.delete()
				.eq("symbol", symbol)
				.then(() => {});
		}
		await deleteAssets(createdSymbols).catch(() => {});
	});

	it("An empty active set (provider failure) aborts before any mutation — no stored symbol is flagged delisted.", async () => {
		const symbol = `${TEST_PREFIX}SAFE`;
		createdSymbols.push(symbol);
		await upsertAssets([{ symbol, name: "Must Stay Listed Co", type: "stock" }]);

		const warmup = makeFakeWarmup();
		fetchActiveTickersMock.mockResolvedValue(makeUniverse([]));
		enqueueNewSymbolWarmupMock.mockImplementation(warmup.fn);
		const result = await runUniverseReconcile({
			supabase: adminClient,
			logger: rootLogger,
		});

		expect(result.providerFetchFailed).toBe(true);
		expect(result.activeTickersFetched).toBe(0);
		expect(result.allActiveSymbols).toBe(0);
		expect(result.newListingsInserted).toBe(0);
		expect(result.namesUpdated).toBe(0);
		expect(result.untrackedDelistedFlagged).toBe(0);
		expect(result.delistedCleared).toBe(0);
		// No warmup work happened.
		expect(warmup.enqueued).toHaveLength(0);
		// The stored row must NOT have been flagged — this is the catastrophic-failure guard.
		const row = await getAsset(symbol);
		expect(row?.delisted_at).toBeNull();
		// A fully-dark provider must be pageable: this aborts the run with no work
		// done, so it logs at error (ErrorLogAlarm), not warn.
		expectConsoleError(/empty active set/);
	});

	it("A new IPO listing in Massive's active set is inserted with name + type and queued for warmup.", async () => {
		const newSymbol = `${TEST_PREFIX}NEW`;
		createdSymbols.push(newSymbol);

		const warmup = makeFakeWarmup();
		// Target-first + seed-covering tail: step 3 must not flag the shared universe.
		const active = [
			makeActiveTicker({
				symbol: newSymbol,
				name: "FRESHLY LISTED ROBOTICS INC",
				type: "stock",
			}),
			...(await activeSetCoveringSeedExcept([newSymbol])),
		];
		const universe = makeUniverse(active);
		fetchActiveTickersMock.mockResolvedValue(universe);
		enqueueNewSymbolWarmupMock.mockImplementation(warmup.fn);
		const result = await runUniverseReconcile({
			supabase: adminClient,
			logger: rootLogger,
		});

		expect(result.providerFetchFailed).toBe(false);
		expect(result.activeTickersFetched).toBe(active.length);
		expect(result.allActiveSymbols).toBe(universe.allActiveSymbols.size);
		// Only our symbol was new — every seed row already exists in `assets`.
		expect(result.newListingsInserted).toBe(1);
		expect(result.namesUpdated).toBe(0);
		expect(result.insertChunksFailed).toBe(0);

		const row = await getAsset(newSymbol);
		expect(row?.name).toBe("FRESHLY LISTED ROBOTICS INC");
		expect(row?.type).toBe("stock");
		expect(row?.delisted_at).toBeNull();

		// New symbol queued for price warmup.
		expect(result.warmupEnqueued).toBe(1);
		expect(warmup.enqueued).toContainEqual({
			symbol: newSymbol,
			reason: "universe_reconcile_new_listing",
		});
	});

	it("An existing active row refreshes a changed name from Massive and is not re-queued for warmup.", async () => {
		const symbol = `${TEST_PREFIX}KEEP`;
		createdSymbols.push(symbol);
		await upsertAssets([{ symbol, name: "Proper Case Industries Inc", type: "stock" }]);

		const warmup = makeFakeWarmup();
		const active = [
			makeActiveTicker({ symbol, name: "Proper Case Industries, Inc.", type: "stock" }),
			...(await activeSetCoveringSeedExcept([symbol])),
		];
		fetchActiveTickersMock.mockResolvedValue(makeUniverse(active));
		enqueueNewSymbolWarmupMock.mockImplementation(warmup.fn);
		const result = await runUniverseReconcile({
			supabase: adminClient,
			logger: rootLogger,
		});

		const row = await getAsset(symbol);
		expect(row?.name).toBe("Proper Case Industries, Inc.");
		// Already listed → not a new listing, not warmed.
		expect(result.newListingsInserted).toBe(0);
		expect(result.namesUpdated).toBe(1);
		expect(result.warmupEnqueued).toBe(0);
		expect(warmup.enqueued).toHaveLength(0);
	});

	it("A previously-delisted symbol that reappears only in the active safety superset has its delisted_at cleared.", async () => {
		const symbol = `${TEST_PREFIX}RBN`;
		createdSymbols.push(symbol);
		await upsertAssets([
			{
				symbol,
				name: "Relisted Manufacturing Co",
				type: "stock",
				delisted_at: "2026-03-15T00:00:00Z",
			},
		]);

		// Sanity: it starts flagged.
		const before = await getAsset(symbol);
		expect(before?.delisted_at).not.toBeNull();

		// The reappearing symbol is ONLY in the superset because its Massive row could
		// not be inserted — the clear must key on superset membership, not the typed subset.
		const active = await activeSetCoveringSeedExcept([symbol]);
		fetchActiveTickersMock.mockResolvedValue(makeUniverse(active, [symbol]));
		const result = await runUniverseReconcile({
			supabase: adminClient,
			logger: rootLogger,
		});

		expect(result.delistedCleared).toBe(1);
		const after = await getAsset(symbol);
		expect(after?.delisted_at).toBeNull();
	});

	it("An UNtracked stored symbol absent from the SUPERSET is flagged delisted, but one present only in the safety superset is not.", async () => {
		const goneSymbol = `${TEST_PREFIX}GONE`;
		const typeQuirkSymbol = `${TEST_PREFIX}QRK`;
		const stillActive = `${TEST_PREFIX}LIVE`;
		createdSymbols.push(goneSymbol, typeQuirkSymbol, stillActive);
		await upsertAssets([
			{ symbol: goneSymbol, name: "Defunct Untracked Inc", type: "stock" },
			{ symbol: typeQuirkSymbol, name: "Reclassified Trust Units", type: "stock" },
			{ symbol: stillActive, name: "Still Trading Inc", type: "stock" },
		]);

		// Active typed set = whole seed universe + `stillActive`, but NOT `goneSymbol`
		// or `typeQuirkSymbol`. `typeQuirkSymbol` stays in the SUPERSET because Massive
		// returned it in a row that could not be inserted; `goneSymbol` is absent from both. Excluding only
		// these two is what isolates the delist-flag to our rows instead of stamping
		// the entire shared seed table delisted.
		const active = await activeSetCoveringSeedExcept([goneSymbol, typeQuirkSymbol]);
		fetchActiveTickersMock.mockResolvedValue(makeUniverse(active, [typeQuirkSymbol]));
		const result = await runUniverseReconcile({
			supabase: adminClient,
			logger: rootLogger,
		});

		// Exactly the one superset-absent untracked symbol is newly flagged.
		expect(result.untrackedDelistedFlagged).toBe(1);
		expect(result.delistFlagSkippedShrunkActive).toBe(false);
		const gone = await getAsset(goneSymbol);
		const quirk = await getAsset(typeQuirkSymbol);
		const live = await getAsset(stillActive);
		expect(gone?.delisted_at).not.toBeNull();
		// Present in the safety superset (just not insertable) → must survive.
		expect(quirk?.delisted_at).toBeNull();
		expect(live?.delisted_at).toBeNull();
	});

	it("A TRACKED symbol absent from the active superset is NEVER flagged by reconcile (the safety carve-out).", async () => {
		const trackedGone = `${TEST_PREFIX}TRK`;
		const untrackedGone = `${TEST_PREFIX}UTRK`;
		createdSymbols.push(trackedGone, untrackedGone);
		await upsertAssets([
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
		// both are "absent from the active superset", the exact delisting condition.
		// The carve-out must flag the untracked one and spare the tracked one.
		const active = await activeSetCoveringSeedExcept([trackedGone, untrackedGone]);
		fetchActiveTickersMock.mockResolvedValue(makeUniverse(active));
		const result = await runUniverseReconcile({
			supabase: adminClient,
			logger: rootLogger,
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

	it("A suspiciously small active set (silent truncation) skips the delist flag rather than mass-delisting live symbols.", async () => {
		const live = `${TEST_PREFIX}FLRA`;
		const untrackedGone = `${TEST_PREFIX}FLRG`;
		createdSymbols.push(live, untrackedGone);
		await upsertAssets([
			{ symbol: live, name: "Still Active Co", type: "stock" },
			{ symbol: untrackedGone, name: "Untracked Absent Co", type: "stock" },
		]);

		// The floor logs at error (it's a degraded run skipping cleanup) → declare it.
		expectConsoleError(/active set implausibly small/);

		// A tiny active set (one symbol) is far below the absolute MIN_PLAUSIBLE_ACTIVE_UNIVERSE
		// floor, so step 3's flagging is skipped. `untrackedGone` is absent from this set and
		// would normally be flagged delisted — the floor spares it.
		const active = [makeActiveTicker({ symbol: live, name: "STILL ACTIVE CO", type: "stock" })];
		fetchActiveTickersMock.mockResolvedValue(makeUniverse(active));
		const result = await runUniverseReconcile({
			supabase: adminClient,
			logger: rootLogger,
		});

		expect(result.delistFlagSkippedShrunkActive).toBe(true);
		expect(result.untrackedDelistedFlagged).toBe(0);
		// The absent untracked symbol is NOT flagged — the floor held back the delete-class op.
		const gone = await getAsset(untrackedGone);
		expect(gone?.delisted_at).toBeNull();
	});

	it("Every newly inserted listing is enqueued for warmup.", async () => {
		const symbols = [
			`${TEST_PREFIX}W1`,
			`${TEST_PREFIX}W2`,
			`${TEST_PREFIX}W3`,
			`${TEST_PREFIX}W4`,
		];
		createdSymbols.push(...symbols);

		const warmup = makeFakeWarmup();
		// All four are brand-new and therefore all four are warmup-eligible.
		const active = [
			...symbols.map((symbol) => makeActiveTicker({ symbol, name: `CAPPED LISTING ${symbol}` })),
			...(await activeSetCoveringSeedExcept(symbols)),
		];
		fetchActiveTickersMock.mockResolvedValue(makeUniverse(active));
		enqueueNewSymbolWarmupMock.mockImplementation(warmup.fn);
		const result = await runUniverseReconcile({
			supabase: adminClient,
			logger: rootLogger,
		});

		// The insert itself is uncapped: all four rows landed in `assets`.
		expect(result.newListingsInserted).toBe(4);
		const rows = await Promise.all(symbols.map((s) => getAsset(s)));
		for (const row of rows) expect(row?.delisted_at).toBeNull();

		expect(result.warmupEnqueued).toBe(4);
		expect(result.warmupEnqueueFailed).toBe(0);
		expect(warmup.enqueued.map((m) => m.symbol)).toEqual(symbols);
	});
});
