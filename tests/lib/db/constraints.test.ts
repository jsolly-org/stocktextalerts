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
			code: "23514",
		});
	});

	it("A user cannot have sms_notifications_enabled while sms_opted_out.", async () => {
		await expect(
			client.query(
				[
					"insert into public.users (",
					"id, email, sms_opted_out, sms_notifications_enabled",
					") values ($1, $2, $3, $4)",
				].join(" "),
				[randomUUID(), `test-${randomUUID()}@example.com`, true, true],
			),
		).rejects.toMatchObject({
			code: "23514",
			constraint: "users_sms_opted_out_blocks_sms_enabled",
			table: "users",
		});
	});

	it("A user cannot be marked phone_verified without a phone number.", async () => {
		await expect(
			client.query("insert into public.users (id, email, phone_verified) values ($1, $2, $3)", [
				randomUUID(),
				`test-${randomUUID()}@example.com`,
				true,
			]),
		).rejects.toMatchObject({
			code: "23514",
			constraint: "users_phone_verified_requires_phone",
			table: "users",
		});
	});
});
