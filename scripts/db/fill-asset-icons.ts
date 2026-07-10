/**
 * One-off: probe Massive branding for every live asset with `icon_checked_at IS NULL`
 * and stamp the result. Intended for a manual drain after removing the nightly drip —
 * not a scheduled job.
 *
 * Usage (local):
 *   npm run db:fill-icons
 *
 * Usage (production — requires explicit approval; writes assets.icon_* only):
 *   npm run db:fill-icons -- --prod
 *
 * Env:
 *   Local: SUPABASE_URL + SUPABASE_SECRET_KEY + MASSIVE_API_KEY from .env.local
 *   Prod:  SUPABASE_URL_PROD + SUPABASE_SECRET_KEY_PROD + MASSIVE_API_KEY
 */
import { createClient } from "@supabase/supabase-js";
import { ensureAssetIconChecked } from "../../src/lib/assets/icon-check";
import type { Database } from "../../src/lib/db/generated/database.types";
import { rootLogger } from "../../src/lib/logging";

const CONCURRENCY = 20;
const PAGE_SIZE = 1000;

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(`${name} is not set`);
	}
	return value;
}

function chunksOf<T>(items: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		chunks.push(items.slice(i, i + size));
	}
	return chunks;
}

async function main(): Promise<void> {
	const useProd = process.argv.includes("--prod");
	const url = useProd ? requireEnv("SUPABASE_URL_PROD") : requireEnv("SUPABASE_URL");
	const key = useProd
		? requireEnv("SUPABASE_SECRET_KEY_PROD")
		: requireEnv("SUPABASE_SECRET_KEY");
	requireEnv("MASSIVE_API_KEY");

	const supabase = createClient<Database>(url, key, {
		auth: { persistSession: false, autoRefreshToken: false },
	});
	const logger = rootLogger;

	console.info(
		`fill-asset-icons — ${useProd ? "PRODUCTION" : "local"} (concurrency ${CONCURRENCY})`,
	);

	const symbols: string[] = [];
	for (let from = 0; ; from += PAGE_SIZE) {
		const { data, error } = await supabase
			.from("assets")
			.select("symbol")
			.is("icon_checked_at", null)
			.is("delisted_at", null)
			.order("symbol", { ascending: true })
			.range(from, from + PAGE_SIZE - 1);
		if (error) throw error;
		const rows = data ?? [];
		for (const row of rows) symbols.push(row.symbol);
		if (rows.length < PAGE_SIZE) break;
	}

	console.info(`  Unchecked live symbols: ${symbols.length}`);
	if (symbols.length === 0) {
		console.info("  Nothing to do.");
		return;
	}

	let probed = 0;
	let iconsFound = 0;
	let failed = 0;
	let completed = 0;

	for (const batch of chunksOf(symbols, CONCURRENCY)) {
		await Promise.all(
			batch.map(async (symbol) => {
				const result = await ensureAssetIconChecked({
					supabase: supabase as never,
					logger,
					symbol,
				});
				if (result.probed) {
					probed += 1;
					if (result.iconUrl !== null) iconsFound += 1;
				} else {
					failed += 1;
				}
			}),
		);
		completed += batch.length;
		if (completed % 500 < CONCURRENCY || completed === symbols.length) {
			console.info(
				`  Progress: ${completed}/${symbols.length} (probed=${probed}, icons=${iconsFound}, failed/skipped=${failed})`,
			);
		}
	}

	console.info(
		[
			"",
			"Done.",
			`  probed (definitive): ${probed}`,
			`  icons found: ${iconsFound}`,
			`  failed/skipped: ${failed}`,
		].join("\n"),
	);
}

main().catch((error) => {
	console.error("fill-asset-icons failed:", error);
	process.exitCode = 1;
});
