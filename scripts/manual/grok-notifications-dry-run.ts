import { DateTime } from "luxon";
import { generateDailyExtrasWithGrok } from "../../src/lib/grok/extras";
import { createLogger } from "../../src/lib/logging";
import { formatSmsMessage } from "../../src/lib/messaging/sms/delivery";

const requestId = "scripts/grok-notifications-dry-run";
const logger = createLogger({ requestId, action: "grok_notifications_dry_run" });

function usage(): string {
	return [
		"Usage:",
		"  npm run grok:notifications -- --tickers AAPL,MSFT [--kinds news,rumors] [--timezone America/New_York] [--date 2026-02-08] [--market-open true|false]",
		"",
		"Examples:",
		"  npm run grok:notifications -- --tickers AAPL,MSFT",
		"  npm run grok:notifications -- --tickers NVDA --kinds news",
		"",
		"Notes:",
		"  - Requires XAI_API_KEY in .env.local (see env.example).",
		"  - This does NOT send SMS/email; it prints a preview only.",
	].join("\n");
}

function parseTickers(raw: string | undefined): string[] {
	if (!raw) return [];
	return raw
		.split(",")
		.map((t) => t.trim().toUpperCase())
		.filter(Boolean);
}

function getArgValue(args: string[], name: string): string | undefined {
	const idx = args.indexOf(name);
	if (idx === -1) return undefined;
	return args[idx + 1];
}

function parseBoolean(value: string | undefined): boolean | undefined {
	if (value === "true") return true;
	if (value === "false") return false;
	return undefined;
}

function parseKinds(raw: string | undefined): { includeNews: boolean; includeRumors: boolean } {
	if (!raw) {
		return { includeNews: true, includeRumors: true };
	}

	const kinds = raw
		.split(",")
		.map((k) => k.trim().toLowerCase())
		.filter(Boolean);

	return {
		includeNews: kinds.includes("news"),
		includeRumors: kinds.includes("rumors"),
	};
}

function buildStocksListPlaceholder(tickers: string[]): string {
	if (tickers.length === 0) {
		return "(no tickers)";
	}
	return tickers.map((t) => `${t}: $123.45 (+0.0%)`).join("\n");
}

async function main() {
	const args = process.argv.slice(2);
	const help = args.includes("--help") || args.includes("-h");
	if (help) {
		logger.info(usage(), { event: "usage" });
		return;
	}

	const tickers = parseTickers(getArgValue(args, "--tickers"));
	if (tickers.length === 0) {
		logger.info("Missing required arg: --tickers AAPL,MSFT\n\n" + usage(), {
			event: "invalid_args",
			reason: "missing_tickers",
		});
		process.exitCode = 2;
		return;
	}

	const { includeNews, includeRumors } = parseKinds(getArgValue(args, "--kinds"));
	if (!includeNews && !includeRumors) {
		logger.info(
			"Invalid --kinds (expected a comma list containing 'news' and/or 'rumors').\n\n" +
				usage(),
			{ event: "invalid_args", reason: "invalid_kinds", tickers },
		);
		process.exitCode = 2;
		return;
	}

	const timezone = getArgValue(args, "--timezone") ?? "America/New_York";
	const dateArg = getArgValue(args, "--date");
	const marketOpen =
		parseBoolean(getArgValue(args, "--market-open")) ??
		(DateTime.now().setZone("America/New_York").weekday <= 5);

	let localDateIso: string;
	if (dateArg) {
		const parsed = DateTime.fromISO(dateArg, { zone: timezone });
		if (!parsed.isValid) {
			logger.info(`Invalid --date (expected YYYY-MM-DD): ${dateArg}`, {
				event: "invalid_args",
				reason: "invalid_date",
				tickers,
				timezone,
			});
			process.exitCode = 2;
			return;
		}
		const iso = parsed.toISODate();
		if (!iso) {
			logger.info(`Failed to format --date: ${dateArg}`, {
				event: "invalid_args",
				reason: "failed_date_formatting",
				tickers,
				timezone,
			});
			process.exitCode = 2;
			return;
		}
		localDateIso = iso;
	} else {
		const now = DateTime.now().setZone(timezone);
		const iso = now.toISODate();
		if (!iso) {
			logger.info(`Failed to format today's date for timezone: ${timezone}`, {
				event: "invalid_args",
				reason: "failed_timezone_date_formatting",
				tickers,
				timezone,
			});
			process.exitCode = 2;
			return;
		}
		localDateIso = iso;
	}

	logger.info("Grok notification dry run starting", {
		event: "start",
		tickers,
		timezone,
		localDateIso,
		includeNews,
		includeRumors,
		marketOpen,
	});

	const extras = await generateDailyExtrasWithGrok({
		tickers,
		localDateIso,
		timezone,
		includeNews,
		includeRumors,
		requestId,
	});

	if (!extras?.news && !extras?.rumors) {
		logger.info(
			"No Grok content generated (likely missing XAI_API_KEY, request failed, or empty response).",
			{
				event: "no_grok_content",
				tickers,
				timezone,
				localDateIso,
				includeNews,
				includeRumors,
			},
		);
		return;
	}

	if (extras.news) {
		logger.info("Grok output (raw) [news]", {
			event: "grok_output_raw",
			kind: "news",
			tickers,
			timezone,
			localDateIso,
			includeNews,
			includeRumors,
			text: extras.news,
		});
	}
	if (extras.rumors) {
		logger.info("Grok output (raw) [rumors]", {
			event: "grok_output_raw",
			kind: "rumors",
			tickers,
			timezone,
			localDateIso,
			includeNews,
			includeRumors,
			text: extras.rumors,
		});
	}

	const sms = formatSmsMessage(buildStocksListPlaceholder(tickers), marketOpen, extras);
	logger.info("SMS preview (Grok content appended)", {
		event: "sms_preview",
		tickers,
		timezone,
		localDateIso,
		includeNews,
		includeRumors,
		marketOpen,
		sms,
	});
}

main().catch((error: unknown) => {
	logger.error(
		"Unhandled error during grok notifications dry run",
		{ event: "unhandled_error" },
		error,
	);
	process.exitCode = 1;
});

