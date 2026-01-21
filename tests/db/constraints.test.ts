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

function createDbClient(): Client {
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) {
		throw new Error("Missing DATABASE_URL");
	}
	return new Client({ connectionString: databaseUrl });
}

describe("database constraints and validation functions", () => {
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

	it("public.has_no_whitespace returns expected results", async () => {
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

	it("rejects stocks.symbol containing whitespace (stocks_symbol_no_whitespace)", async () => {
		await expect(
			client.query(
				"insert into public.stocks (symbol, name, exchange) values ($1, $2, $3)",
				["A A", "Test Stock", "NASDAQ"],
			),
		).rejects.toMatchObject({
			code: "23514",
			constraint: "stocks_symbol_no_whitespace",
			table: "stocks",
		});
	});

	it("rejects users.email containing whitespace (users_email_no_whitespace)", async () => {
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

	it("replace_user_stocks rejects any whitespace in symbols (check_violation)", async () => {
		const userId = randomUUID();
		await client.query("insert into public.users (id, email) values ($1, $2)", [
			userId,
			`test-${randomUUID()}@resend.dev`,
		]);

		await client.query(
			"insert into public.stocks (symbol, name, exchange) values ($1, $2, $3) on conflict (symbol) do nothing",
			["AAPL", "Apple Inc.", "NASDAQ"],
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

	it("replace_user_stocks rejects symbols that are not uppercase (check_violation)", async () => {
		const userId = randomUUID();
		await client.query("insert into public.users (id, email) values ($1, $2)", [
			userId,
			`test-${randomUUID()}@resend.dev`,
		]);

		await client.query(
			"insert into public.stocks (symbol, name, exchange) values ($1, $2, $3) on conflict (symbol) do nothing",
			["aapl", "Apple Inc.", "NASDAQ"],
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

	it("replace_user_stocks rejects duplicate symbols (check_violation)", async () => {
		const userId = randomUUID();
		await client.query("insert into public.users (id, email) values ($1, $2)", [
			userId,
			`test-${randomUUID()}@resend.dev`,
		]);

		await client.query(
			"insert into public.stocks (symbol, name, exchange) values ($1, $2, $3), ($4, $5, $6) on conflict (symbol) do nothing",
			["AAPL", "Apple Inc.", "NASDAQ", "MSFT", "Microsoft Corp.", "NASDAQ"],
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
