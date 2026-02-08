import { randomUUID } from "node:crypto";
import { Client } from "pg";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import { getStockData } from "../../helpers/stock-data";

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

	it("A stock symbol with whitespace is rejected when adding it to the database.", async () => {
		const realStock = getStockData("AAPL");
		await expect(
			client.query(
				"insert into public.stocks (symbol, name, exchange) values ($1, $2, $3)",
				["A A", realStock.name, realStock.exchange],
			),
		).rejects.toMatchObject({
			code: "23514",
			constraint: "stocks_symbol_no_whitespace",
			table: "stocks",
		});
	});

	it("An email address with whitespace is rejected when creating a user.", async () => {
		await expect(
			client.query("insert into public.users (id, email) values ($1, $2)", [
				randomUUID(),
				"has space@resend.dev",
			]),
		).rejects.toMatchObject({
			code: "23514",
			constraint: "users_email_no_whitespace",
			table: "users",
		});
	});

	it("A user cannot replace tracked stocks with symbols that include whitespace.", async () => {
		const userId = randomUUID();
		await client.query("insert into public.users (id, email) values ($1, $2)", [
			userId,
			`test-${randomUUID()}@resend.dev`,
		]);

		const aaplStock = getStockData("AAPL");
		await client.query(
			"insert into public.stocks (symbol, name, exchange) values ($1, $2, $3) on conflict (symbol) do nothing",
			["AAPL", aaplStock.name, aaplStock.exchange],
		);

		await expect(
			client.query("select public.replace_user_stocks($1::uuid, $2::text[])", [
				userId,
				["AAPL "],
			]),
		).rejects.toMatchObject({
			code: "23514",
		});
	});

	it("A user cannot replace tracked stocks with lowercase symbols.", async () => {
		const userId = randomUUID();
		await client.query("insert into public.users (id, email) values ($1, $2)", [
			userId,
			`test-${randomUUID()}@resend.dev`,
		]);

		const aaplStock = getStockData("AAPL");
		await client.query(
			"insert into public.stocks (symbol, name, exchange) values ($1, $2, $3) on conflict (symbol) do nothing",
			["aapl", aaplStock.name, aaplStock.exchange],
		);

		await expect(
			client.query("select public.replace_user_stocks($1::uuid, $2::text[])", [
				userId,
				["aapl"],
			]),
		).rejects.toMatchObject({
			code: "23514",
		});
	});

	it("A user cannot replace tracked stocks with duplicate symbols.", async () => {
		const userId = randomUUID();
		await client.query("insert into public.users (id, email) values ($1, $2)", [
			userId,
			`test-${randomUUID()}@resend.dev`,
		]);

		const aaplStock = getStockData("AAPL");
		const msftStock = getStockData("MSFT");
		await client.query(
			"insert into public.stocks (symbol, name, exchange) values ($1, $2, $3), ($4, $5, $6) on conflict (symbol) do nothing",
			[
				"AAPL",
				aaplStock.name,
				aaplStock.exchange,
				"MSFT",
				msftStock.name,
				msftStock.exchange,
			],
		);

		await expect(
			client.query("select public.replace_user_stocks($1::uuid, $2::text[])", [
				userId,
				["AAPL", "MSFT", "AAPL"],
			]),
		).rejects.toMatchObject({
			code: "23514",
		});
	});
});
