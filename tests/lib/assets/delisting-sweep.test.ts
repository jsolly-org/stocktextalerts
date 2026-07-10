/**
 * Integration tests for the daily delisting sweep.
 *
 * Uses real local Supabase + real email template + fake Massive
 * reference lookup + fake EmailSender. Test symbols use a
 * `Z`-prefix pattern that won't collide with real tickers.
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchTickerReferencesMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/lib/assets/reference/delistings", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../../src/lib/assets/reference/delistings")>();
	return {
		...actual,
		fetchTickerReferences: fetchTickerReferencesMock,
	};
});

import { runDelistingSweep } from "../../../src/lib/assets/delisting-sweep";
import type { TickerReferenceStatus } from "../../../src/lib/assets/reference/delistings";
import { rootLogger } from "../../../src/lib/logging";
import type { EmailRequest, EmailSender } from "../../../src/lib/messaging/types";
import type { DeliveryResult } from "../../../src/lib/types";
import { deleteAssets, upsertAssets } from "../../helpers/asset-db";
import { adminClient } from "../../helpers/test-env";
import { createTestUser } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

type DelistedSeed = { name: string; delistedUtc: string; exchange: string };

function makeFakeLookup(
	delisted: Map<string, DelistedSeed>,
	overrides?: Map<string, TickerReferenceStatus["status"]>,
) {
	return async (symbols: string[]): Promise<TickerReferenceStatus[]> =>
		symbols.map((symbol): TickerReferenceStatus => {
			const override = overrides?.get(symbol);
			if (override === "provider_error") {
				return { status: "provider_error", symbol };
			}
			const hit = delisted.get(symbol);
			if (!hit) return { status: "unknown", symbol };
			return {
				status: "delisted",
				result: {
					symbol,
					active: false,
					delistedUtc: hit.delistedUtc,
					primaryExchange: hit.exchange,
					name: hit.name,
				},
			};
		});
}

function makeFakeEmailSender(): {
	sender: EmailSender;
	captured: EmailRequest[];
	setResult(result: DeliveryResult): void;
} {
	const captured: EmailRequest[] = [];
	let nextResult: DeliveryResult = {
		success: true,
		messageSid: "test-msg-001",
	};
	return {
		captured,
		setResult(r) {
			nextResult = r;
		},
		sender: async (request) => {
			captured.push(request);
			return nextResult;
		},
	};
}

/**
 * Unique test symbol prefix (max 10 chars, alphanumeric uppercase).
 * Using `Z` prefix keeps us out of real-ticker space and a per-file
 * random suffix avoids collisions between parallel/future tests.
 */
const TEST_PREFIX = `Z${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;

async function insertAsset(symbol: string, name: string): Promise<void> {
	await upsertAssets([{ symbol, name, type: "stock" }]);
}

async function deleteAsset(symbol: string): Promise<void> {
	await adminClient.from("user_assets").delete().eq("symbol", symbol);
	await deleteAssets([symbol]);
}

async function attachUserAsset(userId: string, symbol: string): Promise<void> {
	const { error } = await adminClient.from("user_assets").insert({ user_id: userId, symbol });
	if (error) throw new Error(`attachUserAsset failed: ${error.message}`);
}

describe("runDelistingSweep", () => {
	const createdSymbols: string[] = [];

	beforeEach(() => {
		createdSymbols.length = 0;
		fetchTickerReferencesMock.mockReset();
	});

	afterEach(async () => {
		for (const symbol of createdSymbols) {
			await deleteAsset(symbol).catch(() => {});
		}
	});

	it("Detects a newly-delisted SPAC, notifies the user, and cleans up user_assets.", async () => {
		const delistedSymbol = `${TEST_PREFIX}A`;
		const activeSymbol = `${TEST_PREFIX}B`;
		createdSymbols.push(delistedSymbol, activeSymbol);

		await insertAsset(delistedSymbol, "Test Failed SPAC Acquisition Corp - Class A");
		await insertAsset(activeSymbol, "Test Healthy Company Inc");

		const user = await createTestUser({
			email: `delist-detect-${randomUUID()}@example.com`,
			confirmed: true,
			emailNotificationsEnabled: true,
			timezone: "America/Los_Angeles",
		});
		registerTestUserForCleanup(user.id);
		await attachUserAsset(user.id, delistedSymbol);
		await attachUserAsset(user.id, activeSymbol);

		const fakeEmail = makeFakeEmailSender();
		fetchTickerReferencesMock.mockImplementation(
			makeFakeLookup(
				new Map([
					[
						delistedSymbol,
						{
							name: "Test Failed SPAC Acquisition Corp - Class A",
							delistedUtc: "2026-03-27",
							exchange: "NASDAQ",
						},
					],
				]),
			),
		);
		const result = await runDelistingSweep({
			supabase: adminClient,
			logger: rootLogger,
			sendEmail: fakeEmail.sender,
		});

		expect(result.newlyDetectedDelistings).toBe(1);
		expect(result.usersNotified).toBe(1);
		expect(result.emailsDelivered).toBe(1);
		expect(result.userAssetRowsDeleted).toBeGreaterThanOrEqual(1);
		expect(result.providerErrors).toBe(0);

		// Email captured with the right shape
		expect(fakeEmail.captured).toHaveLength(1);
		const sent = fakeEmail.captured[0]!;
		expect(sent.to).toBe(user.email);
		expect(sent.subject).toContain(delistedSymbol);
		expect(sent.subject).toContain("delisted");
		expect(sent.html).toContain(delistedSymbol);
		expect(sent.html).toContain("2026-03-27");
		expect(sent.html).toContain("NASDAQ");

		// assets.delisted_at set for the delisted symbol only
		const { data: assetRows } = await adminClient
			.from("assets")
			.select("symbol, delisted_at")
			.in("symbol", [delistedSymbol, activeSymbol]);
		const bySymbol = new Map((assetRows ?? []).map((r) => [r.symbol, r.delisted_at]));
		expect(bySymbol.get(delistedSymbol)).toBe("2026-03-27T00:00:00+00:00");
		expect(bySymbol.get(activeSymbol)).toBeNull();

		// user_assets cleaned up only for the delisted symbol
		const { data: userAssets } = await adminClient
			.from("user_assets")
			.select("symbol")
			.eq("user_id", user.id);
		const remaining = new Set((userAssets ?? []).map((r) => r.symbol));
		expect(remaining.has(delistedSymbol)).toBe(false);
		expect(remaining.has(activeSymbol)).toBe(true);

		// One notification_log row — the delivered email.
		const { data: logRows } = await adminClient
			.from("notification_log")
			.select("type, delivery_method, message_delivered, error")
			.eq("user_id", user.id)
			.eq("type", "delisting");
		expect(logRows ?? []).toHaveLength(1);
		const emailRow = logRows?.find((r) => r.delivery_method === "email");
		expect(emailRow?.message_delivered).toBe(true);
	});

	it("Checks every unchecked tracked symbol in one nightly sweep.", async () => {
		const uncheckedSymbols = Array.from(
			{ length: 16 },
			(_, index) => `${TEST_PREFIX}C${index.toString(36).toUpperCase()}`,
		);
		for (const symbol of uncheckedSymbols) {
			createdSymbols.push(symbol);
			await insertAsset(symbol, `Test Unchecked ${symbol}`);
		}

		const user = await createTestUser({
			email: `delist-all-unchecked-${randomUUID()}@example.com`,
			confirmed: true,
			emailNotificationsEnabled: true,
		});
		registerTestUserForCleanup(user.id);
		for (const symbol of uncheckedSymbols) {
			await attachUserAsset(user.id, symbol);
		}

		const fakeEmail = makeFakeEmailSender();
		fetchTickerReferencesMock.mockImplementation(makeFakeLookup(new Map()));
		const result = await runDelistingSweep({
			supabase: adminClient,
			logger: rootLogger,
			sendEmail: fakeEmail.sender,
		});

		expect(fetchTickerReferencesMock).toHaveBeenCalledTimes(1);
		const checkedSymbols = fetchTickerReferencesMock.mock.calls[0]![0] as string[];
		expect(checkedSymbols).toEqual(expect.arrayContaining(uncheckedSymbols));
		expect(uncheckedSymbols.every((symbol) => checkedSymbols.includes(symbol))).toBe(true);
		expect(result.symbolsChecked).toBe(checkedSymbols.length);
		expect(fakeEmail.captured).toHaveLength(0);
	});

	it("Consolidates multiple delisted holdings into a single email.", async () => {
		const symbolsToDelist = [`${TEST_PREFIX}M1`, `${TEST_PREFIX}M2`, `${TEST_PREFIX}M3`];
		for (const s of symbolsToDelist) {
			createdSymbols.push(s);
			await insertAsset(s, `Test Multi Holding ${s}`);
		}

		const user = await createTestUser({
			email: `delist-multi-${randomUUID()}@example.com`,
			confirmed: true,
			emailNotificationsEnabled: true,
		});
		registerTestUserForCleanup(user.id);
		for (const s of symbolsToDelist) {
			await attachUserAsset(user.id, s);
		}

		const delistedMap = new Map<string, DelistedSeed>(
			symbolsToDelist.map((s) => [
				s,
				{
					name: `Test Multi Holding ${s}`,
					delistedUtc: "2026-04-01",
					exchange: "NYSE",
				},
			]),
		);

		const fakeEmail = makeFakeEmailSender();
		fetchTickerReferencesMock.mockImplementation(makeFakeLookup(delistedMap));
		const result = await runDelistingSweep({
			supabase: adminClient,
			logger: rootLogger,
			sendEmail: fakeEmail.sender,
		});

		expect(result.newlyDetectedDelistings).toBe(3);
		expect(result.usersNotified).toBe(1);
		expect(result.emailsDelivered).toBe(1);
		expect(fakeEmail.captured).toHaveLength(1);

		const sent = fakeEmail.captured[0]!;
		expect(sent.subject).toContain("3 of your tracked stocks");
		for (const s of symbolsToDelist) {
			expect(sent.html).toContain(s);
		}

		// One row: the delivered email.
		const { data: logRows } = await adminClient
			.from("notification_log")
			.select("delivery_method, message_delivered")
			.eq("user_id", user.id)
			.eq("type", "delisting");
		expect(logRows ?? []).toHaveLength(1);
	});

	it("Does not resend to a user who was already notified within the 48h dedupe window.", async () => {
		const delistedSymbol = `${TEST_PREFIX}D1`;
		createdSymbols.push(delistedSymbol);
		await insertAsset(delistedSymbol, "Test Dedupe Ltd");

		const user = await createTestUser({
			email: `delist-dedupe-${randomUUID()}@example.com`,
			confirmed: true,
			emailNotificationsEnabled: true,
		});
		registerTestUserForCleanup(user.id);
		await attachUserAsset(user.id, delistedSymbol);

		// Seed a prior successful notification_log row within the dedupe window.
		await adminClient.from("notification_log").insert({
			user_id: user.id,
			type: "delisting",
			delivery_method: "email",
			message_delivered: true,
			message: "Delisted: prior notification",
		});

		const fakeEmail = makeFakeEmailSender();
		fetchTickerReferencesMock.mockImplementation(
			makeFakeLookup(
				new Map([
					[
						delistedSymbol,
						{
							name: "Test Dedupe Ltd",
							delistedUtc: "2026-04-05",
							exchange: "NYSE",
						},
					],
				]),
			),
		);
		const result = await runDelistingSweep({
			supabase: adminClient,
			logger: rootLogger,
			sendEmail: fakeEmail.sender,
		});

		// No new email sent (dedupe path) — cleanup still runs because the email
		// channel had no transient failure.
		expect(fakeEmail.captured).toHaveLength(0);
		expect(result.usersNotified).toBe(0);
		expect(result.userAssetRowsDeleted).toBeGreaterThanOrEqual(1);

		const { data: userAssets } = await adminClient
			.from("user_assets")
			.select("symbol")
			.eq("user_id", user.id);
		expect(userAssets ?? []).toHaveLength(0);
	});

	it("Respects email_notifications_enabled: false — skips send, still cleans up.", async () => {
		const delistedSymbol = `${TEST_PREFIX}O1`;
		createdSymbols.push(delistedSymbol);
		await insertAsset(delistedSymbol, "Test OptOut Holdings");

		const user = await createTestUser({
			email: `delist-optout-${randomUUID()}@example.com`,
			confirmed: true,
			emailNotificationsEnabled: false,
		});
		registerTestUserForCleanup(user.id);
		await attachUserAsset(user.id, delistedSymbol);

		const fakeEmail = makeFakeEmailSender();
		fetchTickerReferencesMock.mockImplementation(
			makeFakeLookup(
				new Map([
					[
						delistedSymbol,
						{
							name: "Test OptOut Holdings",
							delistedUtc: "2026-04-05",
							exchange: "NASDAQ",
						},
					],
				]),
			),
		);
		const result = await runDelistingSweep({
			supabase: adminClient,
			logger: rootLogger,
			sendEmail: fakeEmail.sender,
		});

		// Email opted out: no send, skip row logged, cleanup runs.
		expect(fakeEmail.captured).toHaveLength(0);
		expect(result.emailsSkippedOptOut).toBe(1);
		expect(result.usersNotified).toBe(0);
		expect(result.userAssetRowsDeleted).toBeGreaterThanOrEqual(1);

		const { data: logRows } = await adminClient
			.from("notification_log")
			.select("delivery_method, message_delivered, error")
			.eq("user_id", user.id)
			.eq("type", "delisting")
			.order("delivery_method");
		expect(logRows ?? []).toHaveLength(1);
		const emailRow = logRows?.find((r) => r.delivery_method === "email");
		expect(emailRow?.message_delivered).toBe(false);
		expect(emailRow?.error).toBe("email_notifications_disabled");
	});

	it("Retains user_assets when the email send fails, so the next run can retry.", async () => {
		const delistedSymbol = `${TEST_PREFIX}F1`;
		createdSymbols.push(delistedSymbol);
		await insertAsset(delistedSymbol, "Test SES Throttle Inc");

		const user = await createTestUser({
			email: `delist-fail-${randomUUID()}@example.com`,
			confirmed: true,
			emailNotificationsEnabled: true,
		});
		registerTestUserForCleanup(user.id);
		await attachUserAsset(user.id, delistedSymbol);

		const fakeEmail = makeFakeEmailSender();
		fakeEmail.setResult({
			success: false,
			error: "SES throttled",
			errorCode: "Throttling",
		});

		fetchTickerReferencesMock.mockImplementation(
			makeFakeLookup(
				new Map([
					[
						delistedSymbol,
						{
							name: "Test SES Throttle Inc",
							delistedUtc: "2026-04-05",
							exchange: "NASDAQ",
						},
					],
				]),
			),
		);
		const result1 = await runDelistingSweep({
			supabase: adminClient,
			logger: rootLogger,
			sendEmail: fakeEmail.sender,
		});

		expect(result1.emailsFailed).toBe(1);
		expect(result1.userAssetRowsDeleted).toBe(0);

		// user_assets row should still be present
		const { data: stillHeld } = await adminClient
			.from("user_assets")
			.select("symbol")
			.eq("user_id", user.id);
		expect(stillHeld ?? []).toHaveLength(1);

		// Second run with the sender flipped to success should complete cleanup.
		fakeEmail.setResult({ success: true, messageSid: "test-msg-retry" });
		fetchTickerReferencesMock.mockImplementation(
			makeFakeLookup(
				new Map([
					[
						delistedSymbol,
						{
							name: "Test SES Throttle Inc",
							delistedUtc: "2026-04-05",
							exchange: "NASDAQ",
						},
					],
				]),
			),
		);
		const result2 = await runDelistingSweep({
			supabase: adminClient,
			logger: rootLogger,
			sendEmail: fakeEmail.sender,
		});
		expect(result2.usersNotified).toBe(1);
		expect(result2.userAssetRowsDeleted).toBeGreaterThanOrEqual(1);

		const { data: cleanedUp } = await adminClient
			.from("user_assets")
			.select("symbol")
			.eq("user_id", user.id);
		expect(cleanedUp ?? []).toHaveLength(0);
	});

	it("Does not flag symbols whose reference lookup returns unknown.", async () => {
		const unknownSymbol = `${TEST_PREFIX}U1`;
		createdSymbols.push(unknownSymbol);
		await insertAsset(unknownSymbol, "Test OTC Unknown");

		const user = await createTestUser({
			email: `delist-unknown-${randomUUID()}@example.com`,
			confirmed: true,
			emailNotificationsEnabled: true,
		});
		registerTestUserForCleanup(user.id);
		await attachUserAsset(user.id, unknownSymbol);

		const fakeEmail = makeFakeEmailSender();
		fetchTickerReferencesMock.mockImplementation(makeFakeLookup(new Map()));
		const result = await runDelistingSweep({
			supabase: adminClient,
			logger: rootLogger,
			sendEmail: fakeEmail.sender,
		});

		expect(result.newlyDetectedDelistings).toBe(0);
		expect(fakeEmail.captured).toHaveLength(0);

		const { data: row } = await adminClient
			.from("assets")
			.select("delisted_at")
			.eq("symbol", unknownSymbol)
			.single();
		expect(row?.delisted_at).toBeNull();

		const { data: ua } = await adminClient
			.from("user_assets")
			.select("symbol")
			.eq("user_id", user.id)
			.eq("symbol", unknownSymbol);
		expect(ua ?? []).toHaveLength(1);
	});

	it("Counts provider errors without changing state.", async () => {
		const flakySymbol = `${TEST_PREFIX}P1`;
		createdSymbols.push(flakySymbol);
		await insertAsset(flakySymbol, "Test Provider Flake Inc");

		const user = await createTestUser({
			email: `delist-perror-${randomUUID()}@example.com`,
			confirmed: true,
			emailNotificationsEnabled: true,
		});
		registerTestUserForCleanup(user.id);
		await attachUserAsset(user.id, flakySymbol);

		const overrides = new Map<string, TickerReferenceStatus["status"]>([
			[flakySymbol, "provider_error"],
		]);
		const fakeEmail = makeFakeEmailSender();
		fetchTickerReferencesMock.mockImplementation(makeFakeLookup(new Map(), overrides));
		const result = await runDelistingSweep({
			supabase: adminClient,
			logger: rootLogger,
			sendEmail: fakeEmail.sender,
		});

		expect(result.providerErrors).toBeGreaterThanOrEqual(1);
		expect(result.newlyDetectedDelistings).toBe(0);
		expect(fakeEmail.captured).toHaveLength(0);

		const { data: row } = await adminClient
			.from("assets")
			.select("delisted_at")
			.eq("symbol", flakySymbol)
			.single();
		expect(row?.delisted_at).toBeNull();
	});

	it("Processes already-flagged assets without re-querying Massive.", async () => {
		const preFlaggedSymbol = `${TEST_PREFIX}X1`;
		createdSymbols.push(preFlaggedSymbol);
		await insertAsset(preFlaggedSymbol, "Test Already Flagged Co");
		// Manually pre-flag it (simulating a prior sweep run).
		await adminClient
			.from("assets")
			.update({ delisted_at: "2026-03-01T00:00:00+00:00" })
			.eq("symbol", preFlaggedSymbol);

		const user = await createTestUser({
			email: `delist-prior-${randomUUID()}@example.com`,
			confirmed: true,
			emailNotificationsEnabled: true,
		});
		registerTestUserForCleanup(user.id);
		await attachUserAsset(user.id, preFlaggedSymbol);

		let lookupCallCount = 0;
		const fakeEmail = makeFakeEmailSender();
		fetchTickerReferencesMock.mockImplementation(async (symbols) => {
			lookupCallCount += 1;
			// Should NOT be called for the already-flagged symbol.
			expect(symbols).not.toContain(preFlaggedSymbol);
			return symbols.map((s: string) => ({ status: "unknown" as const, symbol: s }));
		});
		const result = await runDelistingSweep({
			supabase: adminClient,
			logger: rootLogger,
			sendEmail: fakeEmail.sender,
		});

		expect(lookupCallCount).toBeLessThanOrEqual(1);
		expect(result.reprocessedDelistings).toBeGreaterThanOrEqual(1);
		expect(result.usersNotified).toBe(1);
		expect(fakeEmail.captured).toHaveLength(1);
		expect(fakeEmail.captured[0]!.subject).toContain(preFlaggedSymbol);

		const { data: ua } = await adminClient
			.from("user_assets")
			.select("symbol")
			.eq("user_id", user.id)
			.eq("symbol", preFlaggedSymbol);
		expect(ua ?? []).toHaveLength(0);
	});
});
