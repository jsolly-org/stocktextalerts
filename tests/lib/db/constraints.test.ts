import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getAssetData } from "../../helpers/asset-data";

function createDbClient(): Client {
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) {
		throw new Error("Missing DATABASE_URL");
	}
	return new Client({ connectionString: databaseUrl });
}

describe("User input is validated against required data format rules.", () => {
	let client: Client;

	beforeAll(async () => {
		client = createDbClient();
		await client.connect();
	});

	beforeEach(async () => {
		await client.query("BEGIN");
	});

	afterEach(async () => {
		await client.query("ROLLBACK");
	});

	afterAll(async () => {
		await client.end();
	});

	it("The whitespace validator correctly identifies strings with and without spaces or tabs.", async () => {
		const { rows } = await client.query<{
			ok_simple: boolean;
			ok_space: boolean;
			ok_tab: boolean;
		}>(
			[
				"select",
				"  public.has_no_whitespace('ABC') as ok_simple,",
				"  public.has_no_whitespace('A B') as ok_space,",
				"  public.has_no_whitespace(E'A\\tB') as ok_tab",
			].join("\n"),
		);

		expect(rows[0]).toEqual({
			ok_simple: true,
			ok_space: false,
			ok_tab: false,
		});
	});

	it("An asset symbol with whitespace is rejected when adding it to the database.", async () => {
		const realAsset = getAssetData("AAPL");
		await expect(
			client.query("insert into public.assets (symbol, name, type) values ($1, $2, $3)", [
				"A A",
				realAsset.name,
				"stock",
			]),
		).rejects.toMatchObject({
			code: "23514",
			constraint: "assets_symbol_no_whitespace",
			table: "assets",
		});
	});

	it("An email address with whitespace is rejected when creating a user.", async () => {
		await expect(
			client.query("insert into public.users (id, email) values ($1, $2)", [
				randomUUID(),
				"has space@example.com",
			]),
		).rejects.toMatchObject({
			code: "23514",
			constraint: "users_email_no_whitespace",
			table: "users",
		});
	});

	it("A user cannot replace tracked assets with symbols that include whitespace.", async () => {
		const userId = randomUUID();
		await client.query("insert into public.users (id, email) values ($1, $2)", [
			userId,
			`test-${randomUUID()}@example.com`,
		]);

		const aaplAsset = getAssetData("AAPL");
		await client.query(
			"insert into public.assets (symbol, name, type) values ($1, $2, $3) on conflict (symbol) do nothing",
			["AAPL", aaplAsset.name, "stock"],
		);

		await client.query(
			"select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true)",
		);
		await expect(
			client.query("select public.replace_user_assets($1::uuid, $2::text[])", [userId, ["AAPL "]]),
		).rejects.toMatchObject({
			code: "23514",
		});
	});

	it("A user cannot replace tracked assets with lowercase symbols.", async () => {
		const userId = randomUUID();
		await client.query("insert into public.users (id, email) values ($1, $2)", [
			userId,
			`test-${randomUUID()}@example.com`,
		]);

		const aaplAsset = getAssetData("AAPL");
		await client.query(
			"insert into public.assets (symbol, name, type) values ($1, $2, $3) on conflict (symbol) do nothing",
			["aapl", aaplAsset.name, "stock"],
		);

		await client.query(
			"select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true)",
		);
		await expect(
			client.query("select public.replace_user_assets($1::uuid, $2::text[])", [userId, ["aapl"]]),
		).rejects.toMatchObject({
			code: "23514",
		});
	});

	it("A user cannot replace tracked assets with duplicate symbols.", async () => {
		const userId = randomUUID();
		await client.query("insert into public.users (id, email) values ($1, $2)", [
			userId,
			`test-${randomUUID()}@example.com`,
		]);

		const aaplAsset = getAssetData("AAPL");
		const msftAsset = getAssetData("MSFT");
		await client.query(
			"insert into public.assets (symbol, name, type) values ($1, $2, $3), ($4, $5, $6) on conflict (symbol) do nothing",
			["AAPL", aaplAsset.name, "stock", "MSFT", msftAsset.name, "stock"],
		);

		await client.query(
			"select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true)",
		);
		await expect(
			client.query("select public.replace_user_assets($1::uuid, $2::text[])", [
				userId,
				["AAPL", "MSFT", "AAPL"],
			]),
		).rejects.toMatchObject({
			code: "23514",
		});
	});

	it("replace_user_assets preserves created_at for symbols that remain tracked", async () => {
		const userId = randomUUID();
		await client.query("insert into public.users (id, email) values ($1, $2)", [
			userId,
			`test-${randomUUID()}@example.com`,
		]);

		const aaplAsset = getAssetData("AAPL");
		const msftAsset = getAssetData("MSFT");
		await client.query(
			"insert into public.assets (symbol, name, type) values ($1, $2, $3), ($4, $5, $6) on conflict (symbol) do nothing",
			["AAPL", aaplAsset.name, "stock", "MSFT", msftAsset.name, "stock"],
		);

		await client.query(
			"select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true)",
		);
		await client.query("select public.replace_user_assets($1::uuid, $2::text[])", [
			userId,
			["AAPL"],
		]);

		const before = await client.query<{ created_at: string }>(
			"select created_at from public.user_assets where user_id = $1 and symbol = 'AAPL'",
			[userId],
		);
		const originalCreatedAt = before.rows[0]?.created_at;
		expect(originalCreatedAt).toBeTruthy();

		// Force an older timestamp so a reset would be detectable.
		await client.query(
			"update public.user_assets set created_at = $1 where user_id = $2 and symbol = 'AAPL'",
			["2026-01-01T00:00:00.000Z", userId],
		);
		const stamped = await client.query<{ created_at: Date | string }>(
			"select created_at from public.user_assets where user_id = $1 and symbol = 'AAPL'",
			[userId],
		);
		const stampedAt = stamped.rows[0]?.created_at;
		expect(stampedAt).toBeTruthy();
		const stampedIso = stampedAt instanceof Date ? stampedAt.toISOString() : String(stampedAt);

		await client.query("select public.replace_user_assets($1::uuid, $2::text[])", [
			userId,
			["AAPL", "MSFT"],
		]);

		const after = await client.query<{ symbol: string; created_at: Date | string }>(
			"select symbol, created_at from public.user_assets where user_id = $1 order by symbol",
			[userId],
		);
		expect(after.rows.map((r) => r.symbol)).toEqual(["AAPL", "MSFT"]);
		const aaplAfter = after.rows.find((r) => r.symbol === "AAPL")?.created_at;
		const aaplAfterIso = aaplAfter instanceof Date ? aaplAfter.toISOString() : String(aaplAfter);
		expect(aaplAfterIso).toBe(stampedIso);
	});

	it("An asset with type 'etf' is accepted by the database.", async () => {
		const spyAsset = getAssetData("SPY");
		const { rowCount } = await client.query(
			"insert into public.assets (symbol, name, type) values ($1, $2, $3) on conflict (symbol) do nothing",
			[spyAsset.symbol, spyAsset.name, "etf"],
		);

		// Either inserted (1) or already existed (0) — no constraint violation
		expect(rowCount).toBeLessThanOrEqual(1);
	});

	it("An asset with an invalid type is rejected by the database.", async () => {
		await expect(
			client.query("insert into public.assets (symbol, name, type) values ($1, $2, $3)", [
				"TESTMF",
				"Test Mutual Fund",
				"mutual_fund",
			]),
		).rejects.toMatchObject({
			code: "22P02",
		});
	});
});
