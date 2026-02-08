import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { rootLogger } from "../../src/lib/logging";
import { isLocalHost } from "../is-local-host";

// --- Environment helpers ---

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(`Missing required env var: ${name}`);
	}
	return value;
}

function getEnv(name: string): string | null {
	const value = process.env[name];
	return value ? value : null;
}

// --- Database URL parsing ---

type ParsedDatabaseUrl = {
	host: string;
	port: string;
	dbname: string;
	username: string;
	password: string;
};

function parseDatabaseUrl(url: string): ParsedDatabaseUrl {
	const u = new URL(url);
	return {
		host: u.hostname,
		port: u.port || "5432",
		dbname: u.pathname.slice(1) || "postgres",
		username: u.username || "postgres",
		password: u.password,
	};
}

function escapePgpassField(s: string): string {
	return s.replace(/[:\\\\]/g, "\\\\$&");
}

// --- psql helper ---

function runPsql(parsed: ParsedDatabaseUrl, sql: string): void {
	const pgpassDir = fs.mkdtempSync(path.join(os.tmpdir(), "db-reset-prod-"));
	const pgpassPath = path.join(pgpassDir, ".pgpass");
	try {
		const line = [
			escapePgpassField(parsed.host),
			escapePgpassField(parsed.port),
			escapePgpassField(parsed.dbname),
			escapePgpassField(parsed.username),
			escapePgpassField(parsed.password),
		].join(":");
		fs.writeFileSync(pgpassPath, `${line}\n`, { mode: 0o600 });
		execFileSync(
			"psql",
			[
				"-v",
				"ON_ERROR_STOP=1",
				"-h",
				parsed.host,
				"-p",
				parsed.port,
				"-U",
				parsed.username,
				"-d",
				parsed.dbname,
				"-c",
				sql,
			],
			{
				stdio: "inherit",
				env: { ...process.env, PGPASSFILE: pgpassPath },
			},
		);
	} finally {
		fs.rmSync(pgpassDir, { recursive: true });
	}
}

// --- Wipe: drop public schema ---

const WIPE_PUBLIC_SQL = `
BEGIN;
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
COMMIT;
`;

// --- Wipe: delete auth users & storage ---

function createAdminClient(supabaseUrl: string, serviceRoleKey: string) {
	return createClient(supabaseUrl, serviceRoleKey, {
		auth: { autoRefreshToken: false, persistSession: false },
	});
}

async function deleteAllAuthUsers(
	supabaseUrl: string,
	serviceRoleKey: string,
) {
	const supabase = createAdminClient(supabaseUrl, serviceRoleKey);
	const perPage = 1000;
	let deleted = 0;

	while (true) {
		const { data, error } = await supabase.auth.admin.listUsers({
			page: 1,
			perPage,
		});
		if (error) throw error;

		const users = data.users ?? [];
		if (users.length === 0) break;

		for (const user of users) {
			const { error: deleteError } =
				await supabase.auth.admin.deleteUser(user.id);
			if (deleteError) throw deleteError;
			deleted += 1;
		}
	}

	rootLogger.info("Deleted auth users from production.", { deleted });
}

type StorageItem = { id?: string | null; name: string };

async function listAllObjects(
	supabase: ReturnType<typeof createAdminClient>,
	bucket: string,
	prefix: string,
	collected: string[],
) {
	let offset = 0;
	const limit = 1000;

	while (true) {
		const { data, error } = await supabase.storage
			.from(bucket)
			.list(prefix, { limit, offset });
		if (error) throw error;
		if (!data || data.length === 0) break;

		for (const item of data as StorageItem[]) {
			const itemPath = prefix ? `${prefix}/${item.name}` : item.name;
			if (!item.id) {
				await listAllObjects(supabase, bucket, itemPath, collected);
				continue;
			}
			collected.push(itemPath);
		}

		if (data.length < limit) break;
		offset += limit;
	}
}

async function deleteAllStorage(
	supabaseUrl: string,
	serviceRoleKey: string,
) {
	const supabase = createAdminClient(supabaseUrl, serviceRoleKey);
	const { data: buckets, error: bucketsError } =
		await supabase.storage.listBuckets();
	if (bucketsError) throw bucketsError;

	let deletedObjects = 0;
	let deletedBuckets = 0;

	for (const bucket of buckets ?? []) {
		const paths: string[] = [];
		await listAllObjects(supabase, bucket.name, "", paths);

		if (paths.length > 0) {
			const { error: removeError } = await supabase.storage
				.from(bucket.name)
				.remove(paths);
			if (removeError) throw removeError;
			deletedObjects += paths.length;
		}

		const { error: deleteError } = await supabase.storage.deleteBucket(
			bucket.name,
		);
		if (deleteError) throw deleteError;
		deletedBuckets += 1;
	}

	rootLogger.info("Deleted storage buckets from production.", {
		deletedBuckets,
		deletedObjects,
	});
}

// --- Repair migrations ---

type MigrationRow = { local: string | null; remote: string | null };

function parseMigrationList(output: string): MigrationRow[] {
	const rows: MigrationRow[] = [];
	for (const line of output.split("\n")) {
		if (!line.trim()) continue;
		if (line.includes("Local") && line.includes("Remote")) continue;
		if (line.includes("---")) continue;
		const parts = line.split("|").map((part) => part.trim());
		if (parts.length < 2) continue;
		const local = parts[0] || null;
		const remote = parts[1] || null;
		if (!local && !remote) continue;
		rows.push({ local, remote });
	}
	return rows;
}

function repairMigrations(): void {
	const output = execFileSync("supabase", ["migration", "list"], {
		encoding: "utf-8",
	});
	const rows = parseMigrationList(output);
	const remoteMigrations = rows
		.filter((r) => r.remote)
		.map((r) => r.remote as string);

	if (remoteMigrations.length === 0) {
		rootLogger.info("No remote migrations to repair.", { count: 0 });
		return;
	}

	rootLogger.info("Marking remote migrations as reverted.", {
		count: remoteMigrations.length,
	});
	execFileSync(
		"supabase",
		["migration", "repair", "--status", "reverted", ...remoteMigrations],
		{ stdio: "inherit" },
	);
}

// --- Seed ---

function applySeed(databaseUrl: string): void {
	const __dirname = path.dirname(fileURLToPath(import.meta.url));
	const seedPath = path.join(__dirname, "..", "..", "supabase", "seed.sql");

	rootLogger.info("Applying seed.sql to production via psql.", {
		context: { seedPath },
	});
	execFileSync(
		"psql",
		["-v", "ON_ERROR_STOP=1", "-f", seedPath, databaseUrl],
		{ stdio: "inherit" },
	);
}

// --- Main ---

async function main(): Promise<void> {
	// Intentionally separate PROD vars so .env.local can keep local defaults.
	const databaseUrlProd = requireEnv("DATABASE_URL_PROD");
	const supabaseUrlProd = requireEnv("PUBLIC_SUPABASE_URL_PROD");
	const supabaseSecretKeyProd =
		getEnv("SUPABASE_SECRET_KEY_PROD") ?? requireEnv("SUPABASE_SECRET_KEY");

	// Expose as canonical env vars for child processes (generate-seed, supabase CLI).
	process.env.DATABASE_URL = databaseUrlProd;
	process.env.PUBLIC_SUPABASE_URL = supabaseUrlProd;
	process.env.SUPABASE_SECRET_KEY = supabaseSecretKeyProd;

	const parsed = parseDatabaseUrl(databaseUrlProd);
	const supabaseHost = new URL(supabaseUrlProd).hostname;

	if (isLocalHost(parsed.host) || isLocalHost(supabaseHost)) {
		throw new Error(
			[
				"Refusing to reset: env vars point to a local Supabase instance.",
				`DATABASE_URL host: ${parsed.host}`,
				`PUBLIC_SUPABASE_URL host: ${supabaseHost}`,
				"Use `supabase db reset` for local development.",
			].join("\n"),
		);
	}

	rootLogger.info("Resetting production database (destructive).", {
		databaseUrlHost: parsed.host,
		supabaseUrlHost: supabaseHost,
	});

	// 1. Generate seed.sql from prod auth users + stock list (+ local scripts/users.json if present)
	const __dirname = path.dirname(fileURLToPath(import.meta.url));
	const seedUsersPath = path.join(__dirname, "..", "users.json");
	if (fs.existsSync(seedUsersPath)) {
		let usersCount: number | null = null;
		try {
			const parsedUsers = JSON.parse(fs.readFileSync(seedUsersPath, "utf-8")) as unknown;
			usersCount = Array.isArray(parsedUsers) ? parsedUsers.length : null;
		} catch {
			// generate-seed will fail later; we still want a loud warning before destructive operations.
		}

		rootLogger.warn(
			"scripts/users.json is present. db:reset:prod will seed these users into production with a password derived from DEFAULT_PASSWORD.",
			{ seedUsersPath, usersCount, supabaseUrlHost: supabaseHost },
		);
	}
	execFileSync("npm", ["run", "db:generate-seed"], {
		stdio: "inherit",
	});

	// 2. Drop public schema, delete auth users & storage
	runPsql(parsed, WIPE_PUBLIC_SQL);
	await deleteAllAuthUsers(supabaseUrlProd, supabaseSecretKeyProd);
	await deleteAllStorage(supabaseUrlProd, supabaseSecretKeyProd);

	// 3. Mark remote migrations as reverted so db push re-applies them
	repairMigrations();

	// 4. Re-apply all migrations
	execFileSync("supabase", ["db", "push", "--include-all"], {
		stdio: "inherit",
	});

	// 5. Seed production
	applySeed(databaseUrlProd);
}

main().catch((error) => {
	rootLogger.error("db reset prod failed", { action: "db_reset_prod" }, error);
	process.exit(1);
});

