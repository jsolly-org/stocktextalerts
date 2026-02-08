import { DateTime } from "luxon";
import { generateFirstNotificationExtrasWithGrok } from "../../src/lib/grok/extras";
import { formatSmsMessage } from "../../src/lib/messaging/sms/delivery";

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
	if (!value) return undefined;
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
		console.log(usage());
		return;
	}

	const tickers = parseTickers(getArgValue(args, "--tickers"));
	if (tickers.length === 0) {
		console.error("Missing required arg: --tickers AAPL,MSFT\n\n" + usage());
		process.exitCode = 2;
		return;
	}

	const { includeNews, includeRumors } = parseKinds(getArgValue(args, "--kinds"));
	if (!includeNews && !includeRumors) {
		console.error(
			"Invalid --kinds (expected a comma list containing 'news' and/or 'rumors').\n\n" +
				usage(),
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
			console.error(`Invalid --date (expected YYYY-MM-DD): ${dateArg}`);
			process.exitCode = 2;
			return;
		}
		const iso = parsed.toISODate();
		if (!iso) {
			console.error(`Failed to format --date: ${dateArg}`);
			process.exitCode = 2;
			return;
		}
		localDateIso = iso;
	} else {
		const now = DateTime.now().setZone(timezone);
		const iso = now.toISODate();
		if (!iso) {
			console.error(`Failed to format today's date for timezone: ${timezone}`);
			process.exitCode = 2;
			return;
		}
		localDateIso = iso;
	}

	console.log("=== Grok notification dry run ===");
	console.log(`tickers: ${tickers.join(", ")}`);
	console.log(`timezone: ${timezone}`);
	console.log(`localDateIso: ${localDateIso}`);
	console.log(
		`kinds: ${[includeNews ? "news" : null, includeRumors ? "rumors" : null]
			.filter(Boolean)
			.join(", ")}`,
	);
	console.log("");

	const extras = await generateFirstNotificationExtrasWithGrok({
		tickers,
		localDateIso,
		timezone,
		includeNews,
		includeRumors,
		requestId: "scripts/grok-notifications-dry-run",
	});

	if (!extras?.news && !extras?.rumors) {
		console.log(
			"No Grok content generated (likely missing XAI_API_KEY, request failed, or empty response).",
		);
		return;
	}

	console.log("=== Grok output (raw) ===");
	if (extras.news) {
		console.log("");
		console.log("[news]");
		console.log(extras.news);
	}
	if (extras.rumors) {
		console.log("");
		console.log("[rumors]");
		console.log(extras.rumors);
	}
	console.log("");

	console.log("=== SMS preview (Grok content appended) ===");
	const sms = formatSmsMessage(buildStocksListPlaceholder(tickers), marketOpen, extras);
	console.log(sms);
}

await main();

