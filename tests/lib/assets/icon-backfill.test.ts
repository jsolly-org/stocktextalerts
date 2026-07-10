/**
 * Integration tests for the nightly icon backfill.
 *
 * Uses real local Supabase (via the service-role `adminClient`, which the backfill
 * itself writes through) + the injectable `getTickerDetail` seam — no network, no
 * live provider keys, no vi.mock needed.
 *
 * Asset fixture seeding goes through `upsertAssets` (direct `pg`, postgres owner)
 * in `tests/helpers/asset-db.ts`: production grants `service_role` only
 * SELECT/UPDATE/INSERT on `public.assets`, and seeding pre-existing rows with the
 * icon columns is an owner concern.
 *
 * Isolation: PostgREST's max_rows (1000) silently clamps `.limit()`, and the
 * shared seed universe (~10.6k rows, all `icon_checked_at IS NULL`) sorts before
 * our Z-prefixed fixtures — so a beforeAll stamps `icon_checked_at` on every
 * currently-unchecked row (`markAllAssetIconsChecked`). Only the per-test
 * fixtures (seeded unchecked) are candidates, which keeps every counter EXACT
 * and lets a small cap cover the whole candidate set.
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ensureAssetIconChecked, runIconBackfill } from "../../../src/lib/assets/icon-backfill";
import type { TickerDetail } from "../../../src/lib/assets/types";
import { rootLogger } from "../../../src/lib/logging";
import { deleteAssets, markAllAssetIconsChecked, upsertAssets } from "../../helpers/asset-db";
import { TEST_PASSWORD } from "../../helpers/constants";
import { adminClient } from "../../helpers/test-env";
import { createTestUser } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";
import { expectConsoleError, warnMessages } from "../../setup";

/**
 * Unique test symbol prefix (max 10 chars, alphanumeric uppercase). `Z` prefix
 * keeps us out of real-ticker space; the random suffix avoids collisions.
 */
const TEST_PREFIX = `Z${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;

/** Small per-run cap — after the beforeAll stamp, only our fixtures are candidates. */
const TEST_CAP = 10;

async function getAsset(symbol: string) {
	const { data } = await adminClient
		.from("assets")
		.select("symbol, icon_url, icon_checked_at, delisted_at")
		.eq("symbol", symbol)
		.maybeSingle();
	return data;
}

/**
 * Build a fake `getTickerDetail` seam that records which symbols it was asked about.
 * Unmapped symbols report a transport failure (`{ ok: false }`) — the module leaves
 * their rows untouched so a later run retries.
 */
function makeFakeDetail(bySymbol?: Map<string, TickerDetail | Error>): {
	fn: (symbol: string) => Promise<TickerDetail>;
	calls: string[];
} {
	const calls: string[] = [];
	const fn = async (symbol: string): Promise<TickerDetail> => {
		calls.push(symbol);
		const detail = bySymbol?.get(symbol);
		if (detail instanceof Error) throw detail;
		return detail ?? { ok: false };
	};
	return { fn, calls };
}

describe("runIconBackfill", () => {
	const createdSymbols: string[] = [];

	beforeAll(async () => {
		// Settle the shared seed universe so only per-test fixtures are candidates
		// (see the isolation note in the file header).
		await markAllAssetIconsChecked();
	});

	afterEach(async () => {
		await deleteAssets(createdSymbols).catch(() => {});
		createdSymbols.length = 0;
	});

	it("A never-checked listing whose Massive detail carries a logo gets icon_url written and icon_checked_at stamped.", async () => {
		const symbol = `${TEST_PREFIX}LOGO`;
		createdSymbols.push(symbol);
		await upsertAssets([{ symbol, name: "Freshly Listed Robotics Inc", type: "stock" }]);

		const detail = makeFakeDetail(
			new Map([
				[
					symbol,
					{
						ok: true,
						iconUrl: `https://api.massive.com/v1/reference/company-branding/${symbol}/images/icon.png`,
					},
				],
			]),
		);
		const result = await runIconBackfill({
			supabase: adminClient,
			logger: rootLogger,
			cap: TEST_CAP,
			getTickerDetail: detail.fn,
		});

		expect(detail.calls).toEqual([symbol]);
		expect(result).toEqual({
			candidatesRemaining: 1,
			checked: 1,
			iconsFound: 1,
			fetchFailed: 0,
			writeFailed: 0,
		});

		const row = await getAsset(symbol);
		expect(row?.icon_url).toBe(
			`https://api.massive.com/v1/reference/company-branding/${symbol}/images/icon.png`,
		);
		expect(row?.icon_checked_at).not.toBeNull();
	});

	it("A definitive 'no logo' answer stamps icon_checked_at with a null icon_url, so the symbol never re-qualifies (the treadmill fix).", async () => {
		const symbol = `${TEST_PREFIX}NONE`;
		createdSymbols.push(symbol);
		await upsertAssets([{ symbol, name: "Logo-Less Holdings LP", type: "stock" }]);

		// Massive answered and has no logo — a definitive "checked, none available".
		const firstRun = makeFakeDetail(new Map([[symbol, { ok: true, iconUrl: null }]]));
		const result = await runIconBackfill({
			supabase: adminClient,
			logger: rootLogger,
			cap: TEST_CAP,
			getTickerDetail: firstRun.fn,
		});

		expect(firstRun.calls).toEqual([symbol]);
		// Counted as checked (the row is settled) but NOT as an icon found.
		expect(result).toEqual({
			candidatesRemaining: 1,
			checked: 1,
			iconsFound: 0,
			fetchFailed: 0,
			writeFailed: 0,
		});
		const row = await getAsset(symbol);
		expect(row?.icon_url).toBeNull();
		expect(row?.icon_checked_at).not.toBeNull();

		// The treadmill fix: on the next run the symbol is no longer a candidate —
		// under the old icon-is-null gate it would have been probed every night forever.
		const secondRun = makeFakeDetail();
		const retryResult = await runIconBackfill({
			supabase: adminClient,
			logger: rootLogger,
			cap: TEST_CAP,
			getTickerDetail: secondRun.fn,
		});
		expect(secondRun.calls).toEqual([]);
		expect(retryResult.candidatesRemaining).toBe(0);
	});

	it("A transport failure (ok:false) leaves the row unchecked, so the next run retries it.", async () => {
		const symbol = `${TEST_PREFIX}RTRY`;
		createdSymbols.push(symbol);
		await upsertAssets([{ symbol, name: "Flaky Fetch Industries", type: "stock" }]);

		// Default seam behavior IS the transport failure — no map entry needed. The
		// whole (one-symbol) batch yields zero definitive answers, which the module
		// reports at ERROR (a fully-dark profile endpoint must page).
		expectConsoleError(/zero definitive answers/);
		const failingRun = makeFakeDetail();
		const result = await runIconBackfill({
			supabase: adminClient,
			logger: rootLogger,
			cap: TEST_CAP,
			getTickerDetail: failingRun.fn,
		});

		expect(failingRun.calls).toEqual([symbol]);
		expect(result).toEqual({
			candidatesRemaining: 1,
			checked: 0,
			iconsFound: 0,
			fetchFailed: 1,
			writeFailed: 0,
		});
		const afterFailure = await getAsset(symbol);
		expect(afterFailure?.icon_url).toBeNull();
		expect(afterFailure?.icon_checked_at).toBeNull();

		// Still a candidate: the next (healthy) run picks it up and settles it.
		const healthyRun = makeFakeDetail(
			new Map([
				[
					symbol,
					{
						ok: true,
						iconUrl: `https://api.massive.com/v1/reference/company-branding/${symbol}/images/icon.png`,
					},
				],
			]),
		);
		const retryResult = await runIconBackfill({
			supabase: adminClient,
			logger: rootLogger,
			cap: TEST_CAP,
			getTickerDetail: healthyRun.fn,
		});
		expect(healthyRun.calls).toEqual([symbol]);
		expect(retryResult).toEqual({
			candidatesRemaining: 1,
			checked: 1,
			iconsFound: 1,
			fetchFailed: 0,
			writeFailed: 0,
		});
		const afterRetry = await getAsset(symbol);
		expect(afterRetry?.icon_url).toBe(
			`https://api.massive.com/v1/reference/company-branding/${symbol}/images/icon.png`,
		);
		expect(afterRetry?.icon_checked_at).not.toBeNull();
	});

	it("A thrown detail fetch is isolated per-symbol: counted as a fetch failure, warned, row left unchecked — the batch survives.", async () => {
		const throwSymbol = `${TEST_PREFIX}THRW`;
		const okSymbol = `${TEST_PREFIX}OKAY`;
		createdSymbols.push(throwSymbol, okSymbol);
		await upsertAssets([
			{ symbol: throwSymbol, name: "Socket Hangup Co", type: "stock" },
			{ symbol: okSymbol, name: "Healthy Detail Co", type: "stock" },
		]);

		const detail = makeFakeDetail(
			new Map<string, TickerDetail | Error>([
				[throwSymbol, new Error("Massive ticker-detail socket hang up")],
				[
					okSymbol,
					{
						ok: true,
						iconUrl: `https://api.massive.com/v1/reference/company-branding/${okSymbol}/images/icon.png`,
					},
				],
			]),
		);
		const result = await runIconBackfill({
			supabase: adminClient,
			logger: rootLogger,
			cap: TEST_CAP,
			getTickerDetail: detail.fn,
		});

		// The throw is a retryable failure, not a crash: the healthy symbol still landed.
		expect(detail.calls).toContain(throwSymbol);
		expect(result).toEqual({
			candidatesRemaining: 2,
			checked: 1,
			iconsFound: 1,
			fetchFailed: 1,
			writeFailed: 0,
		});
		const thrown = await getAsset(throwSymbol);
		expect(thrown?.icon_checked_at).toBeNull();
		const healthy = await getAsset(okSymbol);
		expect(healthy?.icon_url).toBe(
			`https://api.massive.com/v1/reference/company-branding/${okSymbol}/images/icon.png`,
		);
		// The throw is surfaced at warn (transient — the next run retries it).
		expect(warnMessages()).toContainEqual(expect.stringContaining("detail fetch threw"));
	});

	it("A non-allowlisted vendor logo URL is rejected at write time: warned, stored as checked-with-no-icon.", async () => {
		const symbol = `${TEST_PREFIX}EVIL`;
		createdSymbols.push(symbol);
		await upsertAssets([{ symbol, name: "Drifted Vendor URL Corp", type: "stock" }]);

		// A vendor drift/poisoning shape: definitive answer, but the URL is off-allowlist.
		const detail = makeFakeDetail(
			new Map([[symbol, { ok: true, iconUrl: "https://logo.clearbit.com/driftedvendor.com" }]]),
		);
		const result = await runIconBackfill({
			supabase: adminClient,
			logger: rootLogger,
			cap: TEST_CAP,
			getTickerDetail: detail.fn,
		});

		// Checked (settled — never re-probed) but no icon stored: the resolver would
		// 404 that host forever, so it must not be written.
		expect(result).toEqual({
			candidatesRemaining: 1,
			checked: 1,
			iconsFound: 0,
			fetchFailed: 0,
			writeFailed: 0,
		});
		const row = await getAsset(symbol);
		expect(row?.icon_url).toBeNull();
		expect(row?.icon_checked_at).not.toBeNull();
		expect(warnMessages()).toContainEqual(
			expect.stringContaining("rejected non-allowlisted logo URL"),
		);
	});

	it("Tracked symbols fill the cap before the alphabetical drip — a late-alphabet watched ticker beats an earlier untracked one.", async () => {
		const untrackedEarly = `${TEST_PREFIX}AAA`;
		const trackedLate = `${TEST_PREFIX}ZZZ`;
		createdSymbols.push(untrackedEarly, trackedLate);
		await upsertAssets([
			{ symbol: untrackedEarly, name: "Untracked Early Alphabet Inc", type: "stock" },
			{ symbol: trackedLate, name: "Tracked Late Alphabet Inc", type: "stock" },
		]);

		const testUser = await createTestUser({
			email: `icon-prio-${randomUUID()}@example.com`,
			password: TEST_PASSWORD,
			confirmed: true,
		});
		registerTestUserForCleanup(testUser.id);
		const { error: trackError } = await adminClient
			.from("user_assets")
			.insert({ user_id: testUser.id, symbol: trackedLate });
		expect(trackError).toBeNull();

		const detail = makeFakeDetail(
			new Map([
				[
					trackedLate,
					{
						ok: true,
						iconUrl: `https://api.massive.com/v1/reference/company-branding/${trackedLate}/images/icon.png`,
					},
				],
				[
					untrackedEarly,
					{
						ok: true,
						iconUrl: `https://api.massive.com/v1/reference/company-branding/${untrackedEarly}/images/icon.png`,
					},
				],
			]),
		);
		const result = await runIconBackfill({
			supabase: adminClient,
			logger: rootLogger,
			cap: 1,
			getTickerDetail: detail.fn,
		});

		expect(detail.calls).toEqual([trackedLate]);
		expect(result.checked).toBe(1);
		expect(result.iconsFound).toBe(1);
		expect((await getAsset(trackedLate))?.icon_checked_at).not.toBeNull();
		expect((await getAsset(untrackedEarly))?.icon_checked_at).toBeNull();
	});

	it("Already-checked and delisted rows are never candidates — the drip only probes live, never-checked symbols.", async () => {
		const checkedSymbol = `${TEST_PREFIX}DONE`;
		const delistedSymbol = `${TEST_PREFIX}DEAD`;
		createdSymbols.push(checkedSymbol, delistedSymbol);
		await upsertAssets([
			{
				symbol: checkedSymbol,
				name: "Settled Last Month Inc",
				type: "stock",
				icon_url: `https://api.massive.com/v1/reference/company-branding/${checkedSymbol}/images/icon.png`,
				icon_checked_at: "2026-06-15T02:00:00Z",
			},
			{
				symbol: delistedSymbol,
				name: "Defunct Unchecked Inc",
				type: "stock",
				delisted_at: "2026-05-01T00:00:00Z",
			},
		]);

		const detail = makeFakeDetail();
		const result = await runIconBackfill({
			supabase: adminClient,
			logger: rootLogger,
			cap: TEST_CAP,
			getTickerDetail: detail.fn,
		});

		// An empty candidate set: nothing probed, nothing counted, no darkness error.
		expect(detail.calls).toEqual([]);
		expect(result).toEqual({
			candidatesRemaining: 0,
			checked: 0,
			iconsFound: 0,
			fetchFailed: 0,
			writeFailed: 0,
		});
		// Neither row moved.
		const checkedRow = await getAsset(checkedSymbol);
		expect(checkedRow?.icon_url).toBe(
			`https://api.massive.com/v1/reference/company-branding/${checkedSymbol}/images/icon.png`,
		);
		const delistedRow = await getAsset(delistedSymbol);
		expect(delistedRow?.icon_checked_at).toBeNull();
	});

	it("The per-run cap bounds the probe window in symbol order: candidates beyond the cap wait for a later run.", async () => {
		const inWindow = [`${TEST_PREFIX}CAP1`, `${TEST_PREFIX}CAP2`, `${TEST_PREFIX}CAP3`];
		const beyondCap = `${TEST_PREFIX}CAP4`;
		createdSymbols.push(...inWindow, beyondCap);
		await upsertAssets(
			[...inWindow, beyondCap].map((symbol, i) => ({
				symbol,
				name: `Cap Window Fixture ${i + 1} Inc`,
				type: "stock",
			})),
		);

		// Symbol-ordered window: a cap of 3 probes exactly CAP1..CAP3, never CAP4.
		const detail = makeFakeDetail(
			new Map(
				inWindow.map((symbol): [string, TickerDetail] => [
					symbol,
					{
						ok: true,
						iconUrl: `https://api.massive.com/v1/reference/company-branding/${symbol}/images/icon.png`,
					},
				]),
			),
		);
		const result = await runIconBackfill({
			supabase: adminClient,
			logger: rootLogger,
			cap: 3,
			getTickerDetail: detail.fn,
		});

		expect([...detail.calls].sort()).toEqual(inWindow);
		expect(detail.calls).not.toContain(beyondCap);
		// The full backlog is still reported, so the summary shows drain progress.
		expect(result).toEqual({
			candidatesRemaining: 4,
			checked: 3,
			iconsFound: 3,
			fetchFailed: 0,
			writeFailed: 0,
		});
		const row = await getAsset(beyondCap);
		expect(row?.icon_checked_at).toBeNull();
	});
});

describe("ensureAssetIconChecked", () => {
	const createdSymbols: string[] = [];

	beforeAll(async () => {
		await markAllAssetIconsChecked();
	});

	afterEach(async () => {
		await deleteAssets(createdSymbols).catch(() => {});
		createdSymbols.length = 0;
	});

	it("Probes and stamps a never-checked symbol on watchlist add.", async () => {
		const symbol = `${TEST_PREFIX}ADD1`;
		createdSymbols.push(symbol);
		await upsertAssets([{ symbol, name: "On Add Probe Inc", type: "stock" }]);

		const detail = makeFakeDetail(
			new Map([
				[
					symbol,
					{
						ok: true,
						iconUrl: `https://api.massive.com/v1/reference/company-branding/${symbol}/images/icon.png`,
					},
				],
			]),
		);
		const result = await ensureAssetIconChecked({
			supabase: adminClient,
			logger: rootLogger,
			symbol,
			getTickerDetail: detail.fn,
		});

		expect(result).toEqual({
			probed: true,
			iconUrl: `https://api.massive.com/v1/reference/company-branding/${symbol}/images/icon.png`,
		});
		expect(detail.calls).toEqual([symbol]);
		const row = await getAsset(symbol);
		expect(row?.icon_url).toBe(result.iconUrl);
		expect(row?.icon_checked_at).not.toBeNull();
	});

	it("No-ops when the symbol was already checked — Massive is not called again.", async () => {
		const symbol = `${TEST_PREFIX}ADD2`;
		createdSymbols.push(symbol);
		const existingUrl = `https://api.massive.com/v1/reference/company-branding/${symbol}/images/icon.png`;
		await upsertAssets([
			{
				symbol,
				name: "Already Checked Inc",
				type: "stock",
				icon_url: existingUrl,
				icon_checked_at: "2026-06-15T02:00:00Z",
			},
		]);

		const detail = makeFakeDetail();
		const result = await ensureAssetIconChecked({
			supabase: adminClient,
			logger: rootLogger,
			symbol,
			getTickerDetail: detail.fn,
		});

		expect(result).toEqual({ probed: false, iconUrl: existingUrl });
		expect(detail.calls).toEqual([]);
	});
});
