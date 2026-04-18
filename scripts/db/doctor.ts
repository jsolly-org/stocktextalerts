/**
 * scripts/db/doctor.ts — fast preflight for local Supabase bootstrap.
 *
 * Catches the two failure modes that cost us most dev time today:
 *   1. Supabase containers stopped → auth endpoint unreachable (ECONNREFUSED flood).
 *   2. Partial seed → `auth.users` empty so login silently returns `invalid_credentials`.
 *
 * Runs in ~300ms against a healthy local stack. Safe to wire into `predev` /
 * `pretest`.
 *
 * Exit codes:
 *   0 — healthy (or SUPABASE_URL points at a non-local project; we never probe prod)
 *   1 — unhealthy; prints an actionable hint pointing at `npm run db:bootstrap`
 *
 * Usage:
 *   npm run db:doctor
 *   # or: node --env-file-if-exists=.env.local ./node_modules/.bin/tsx scripts/db/doctor.ts
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { rootLogger } from "../../src/lib/logging";
import { isLocalHost } from "./is-local-host";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..", "..");
const USERS_FILE = path.join(projectRoot, "scripts", "data", "users.json");

type SeedUserLite = { email?: unknown };

const HINT = [
  "",
  "💡 Local Supabase bootstrap looks broken.",
  "   Run:  npm run db:bootstrap",
  "   (equivalent to: npm run db:start && npm run db:reset && npm run db:doctor)",
  "",
].join("\n");

/** Short read-timeout guard; doctor must be fast even when the stack is wedged. */
async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), ms);
	try {
		return await fetch(url, { ...init, signal: ctrl.signal });
	} finally {
		clearTimeout(timer);
	}
}

function readFirstSeedEmail(): string | null {
	if (!fs.existsSync(USERS_FILE)) return null;
	try {
		const parsed = JSON.parse(fs.readFileSync(USERS_FILE, "utf-8")) as unknown;
		if (!Array.isArray(parsed) || parsed.length === 0) return null;
		const first = parsed[0] as SeedUserLite;
		const email = typeof first?.email === "string" ? first.email.trim() : "";
		return email || null;
	} catch {
		return null;
	}
}

async function main(): Promise<void> {
	const supabaseUrl = process.env.SUPABASE_URL;
	const publishableKey =
		process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;

	if (!supabaseUrl) {
		rootLogger.error("db:doctor — missing SUPABASE_URL in env", {
			action: "db_doctor",
		});
		process.stderr.write(HINT);
		process.exitCode = 1;
		return;
	}

	let host: string;
	try {
		host = new URL(supabaseUrl).hostname;
	} catch {
		rootLogger.error("db:doctor — SUPABASE_URL is not a valid URL", {
			action: "db_doctor",
			supabaseUrl,
		});
		process.stderr.write(HINT);
		process.exitCode = 1;
		return;
	}

	// Never probe production; doctor is a local-only preflight.
	if (!isLocalHost(host)) {
		rootLogger.info("db:doctor — SUPABASE_URL is non-local; skipping checks", {
			action: "db_doctor",
			host,
		});
		return;
	}

	if (!publishableKey) {
		rootLogger.error(
			"db:doctor — missing SUPABASE_PUBLISHABLE_KEY (or SUPABASE_ANON_KEY) in env",
			{ action: "db_doctor" },
		);
		process.stderr.write(HINT);
		process.exitCode = 1;
		return;
	}

	// 1. Auth health — catches "containers stopped" instantly.
	const healthUrl = new URL("/auth/v1/health", supabaseUrl).toString();
	try {
		const res = await fetchWithTimeout(healthUrl, { method: "GET" }, 2_000);
		if (!res.ok) {
			rootLogger.error("db:doctor — auth health check failed", {
				action: "db_doctor",
				healthUrl,
				status: res.status,
			});
			process.stderr.write(HINT);
			process.exitCode = 1;
			return;
		}
	} catch (err) {
		const cause = err instanceof Error ? err.message : String(err);
		rootLogger.error("db:doctor — auth endpoint unreachable", {
			action: "db_doctor",
			healthUrl,
			cause,
		});
		process.stderr.write(HINT);
		process.exitCode = 1;
		return;
	}

	// 2. Login probe — catches partial seeds where auth.users wasn't populated.
	// Only runs if users.json exists (dev-only) and DEFAULT_PASSWORD is set.
	const defaultPassword = process.env.DEFAULT_PASSWORD;
	const seedEmail = readFirstSeedEmail();

	if (!seedEmail || !defaultPassword) {
		rootLogger.info("db:doctor — ok (health only; no seed user to probe)", {
			action: "db_doctor",
			reason: !seedEmail ? "no_users_json" : "no_default_password",
		});
		return;
	}

	const tokenUrl = new URL(
		"/auth/v1/token?grant_type=password",
		supabaseUrl,
	).toString();
	try {
		const res = await fetchWithTimeout(
			tokenUrl,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					apikey: publishableKey,
				},
				body: JSON.stringify({ email: seedEmail, password: defaultPassword }),
			},
			3_000,
		);
		if (!res.ok) {
			let bodySnippet = "";
			try {
				bodySnippet = (await res.text()).slice(0, 200);
			} catch {
				// ignore body read failures; the status code is enough to act on.
			}
			rootLogger.error("db:doctor — seed user login probe failed", {
				action: "db_doctor",
				seedEmail,
				status: res.status,
				bodySnippet,
			});
			process.stderr.write(HINT);
			process.exitCode = 1;
			return;
		}
	} catch (err) {
		const cause = err instanceof Error ? err.message : String(err);
		rootLogger.error("db:doctor — seed user login probe errored", {
			action: "db_doctor",
			seedEmail,
			cause,
		});
		process.stderr.write(HINT);
		process.exitCode = 1;
		return;
	}

	rootLogger.info("db:doctor — ok (auth reachable; seed user login succeeded)", {
		action: "db_doctor",
		seedEmail,
	});
}

main().catch((err) => {
	rootLogger.error(
		"db:doctor — unexpected error",
		{ action: "db_doctor" },
		err,
	);
	process.stderr.write(HINT);
	process.exitCode = 1;
});
