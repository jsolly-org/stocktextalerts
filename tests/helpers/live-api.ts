// Live provider toggles for the test harness. Note:
// - `email` routes through local Mailpit via SMTP, not real SES.
// - `twilio` uses Twilio *test credentials* only (no real delivery, no charges).
type LiveProvider = "massive" | "finnhub" | "xai" | "email" | "twilio";

const ALLOWED_PROVIDERS: LiveProvider[] = [
	"massive",
	"finnhub",
	"xai",
	"email",
	"twilio",
];

function parseCsv(value: string | undefined): string[] {
	if (!value) return [];
	return value
		.split(",")
		.map((item) => item.trim().toLowerCase())
		.filter(Boolean);
}

function parseEnabledProviders(): Set<LiveProvider> {
	const raw =
		process.env.LIVE_API_PROVIDERS ?? process.env.TEST_LIVE_PROVIDERS ?? "";

	if (raw.trim().toLowerCase() === "all") {
		return new Set<LiveProvider>(ALLOWED_PROVIDERS);
	}

	const parsed = parseCsv(raw);
	const enabled = new Set<LiveProvider>();

	for (const item of parsed) {
		if (ALLOWED_PROVIDERS.includes(item as LiveProvider)) {
			enabled.add(item as LiveProvider);
		}
	}

	return enabled;
}

const enabledProviders = parseEnabledProviders();

export function isLiveProviderEnabled(provider: LiveProvider): boolean {
	return enabledProviders.has(provider);
}

export function assertLiveProviderKey(options: {
	provider: LiveProvider;
	envVar: string;
}): void {
	const { provider, envVar } = options;
	if (!isLiveProviderEnabled(provider)) return;
	if (process.env[envVar]) return;
	throw new Error(
		`LIVE_API_PROVIDERS includes "${provider}" but ${envVar} is not set`,
	);
}
