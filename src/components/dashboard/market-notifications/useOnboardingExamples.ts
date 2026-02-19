import { computed, type Ref, ref, watch } from "vue";
import { MOVE_SIZE_THRESHOLDS } from "../../../lib/market-notifications/alert-profile";
import type { InitialAsset } from "../assets/types";

interface AssetPriceData {
	prevClose: number | null;
	sector: string | null;
}

interface FetchedPrices {
	[symbol: string]: AssetPriceData | null;
}

interface DemoAsset {
	symbol: string;
	prevClose: number;
	sector: string;
}

const DEMO_HIGH: DemoAsset = {
	symbol: "AAPL",
	prevClose: 230,
	sector: "Technology",
};
const DEMO_LOW: DemoAsset = {
	symbol: "SOFI",
	prevClose: 12,
	sector: "Financials",
};

/** Stocks below this price are considered "low-priced" for threshold examples. */
const LOW_PRICE_CEILING = 50;

function formatDollar(n: number): string {
	return `$${Math.round(n)}`;
}

function sectorPeerLabel(sector: string): string {
	return `other ${sector.toLowerCase()} stocks`;
}

function pickPrimaryAsset(
	trackedAssets: InitialAsset[],
	prices: FetchedPrices,
): DemoAsset {
	for (const a of trackedAssets) {
		const data = prices[a.symbol];
		if (data?.prevClose && data.prevClose > 0) {
			return {
				symbol: a.symbol,
				prevClose: data.prevClose,
				sector: data.sector ?? "Technology",
			};
		}
	}
	return DEMO_HIGH;
}

/**
 * Pick a high-priced and low-priced asset for Q3 (move size) examples.
 * Uses absolute thresholds — a stock under $50 is "low-priced" regardless of
 * what else the user tracks. Falls back to demo stocks when the user's
 * portfolio doesn't span both ranges.
 */
function pickHighLowPair(
	trackedAssets: InitialAsset[],
	prices: FetchedPrices,
): { hi: DemoAsset; lo: DemoAsset } {
	const withPrices: DemoAsset[] = [];
	for (const a of trackedAssets) {
		const data = prices[a.symbol];
		if (data?.prevClose && data.prevClose > 0) {
			withPrices.push({
				symbol: a.symbol,
				prevClose: data.prevClose,
				sector: data.sector ?? "Other",
			});
		}
	}

	const highCandidates = withPrices
		.filter((a) => a.prevClose >= LOW_PRICE_CEILING)
		.sort((a, b) => b.prevClose - a.prevClose);
	const lowCandidates = withPrices
		.filter((a) => a.prevClose < LOW_PRICE_CEILING)
		.sort((a, b) => a.prevClose - b.prevClose);

	const hi = highCandidates[0] ?? DEMO_HIGH;
	const lo = lowCandidates[0] ?? DEMO_LOW;

	return { hi, lo };
}

export function useOnboardingExamples(
	trackedAssets: Ref<InitialAsset[]>,
	wizardVisible: Ref<boolean>,
) {
	const prices = ref<FetchedPrices>({});
	const fetched = ref(false);
	const loading = ref(false);

	async function fetchPrices() {
		if (fetched.value || loading.value) return;
		loading.value = true;
		try {
			const res = await fetch("/api/assets/prices");
			if (res.ok) {
				const json = (await res.json()) as {
					ok: boolean;
					assets: FetchedPrices;
				};
				if (json.ok) {
					prices.value = json.assets;
				}
			}
		} catch {
			// Fall back to demo data
		} finally {
			fetched.value = true;
			loading.value = false;
		}
	}

	// Fetch lazily when the wizard becomes visible
	watch(
		wizardVisible,
		(visible) => {
			if (visible) fetchPrices();
		},
		{ immediate: true },
	);

	const primary = computed(() =>
		pickPrimaryAsset(trackedAssets.value, prices.value),
	);
	// --- Q1: Market Context (relative to market; magnitude is Q2) ---
	const marketContextOptions = computed(() => {
		const { symbol, sector } = primary.value;
		const peers = sectorPeerLabel(sector);

		return [
			{
				value: "any_major" as const,
				label: "Any big move",
				example: `When ${symbol} moves and ${peers} are moving in the same direction \u2014 you'd still get a text.`,
			},
			{
				value: "standout" as const,
				label: "Only standouts",
				example: `When ${symbol} moves more than ${peers} \u2014 you'd get a text because ${symbol} stands out. If the whole sector moved together, we'd skip it.`,
			},
		];
	});

	// --- Q2: Move Size ---
	const moveSizeOptions = computed(() => {
		const { hi, lo } = pickHighLowPair(trackedAssets.value, prices.value);

		function describeThreshold(tier: "moderate" | "large"): string {
			const { percentThreshold, dollarThreshold } = MOVE_SIZE_THRESHOLDS[tier];

			function moveDescription(prevClose: number): string {
				const pctDollar = prevClose * (percentThreshold / 100);
				return `${percentThreshold}% (~${formatDollar(pctDollar)}) or ${formatDollar(dollarThreshold)}, whichever comes first`;
			}

			const hiLine = `A large asset like ${hi.symbol} (${formatDollar(hi.prevClose)}) alerts on moves of ${moveDescription(hi.prevClose)}.`;
			const loLine = `A smaller asset like ${lo.symbol} (${formatDollar(lo.prevClose)}) will alert when it moves ${moveDescription(lo.prevClose)}.`;
			return `${hiLine}\n${loLine}`;
		}

		return [
			{
				value: "moderate" as const,
				label: "Moderate",
				example: describeThreshold("moderate"),
			},
			{
				value: "large" as const,
				label: "Large",
				example: describeThreshold("large"),
			},
		];
	});

	// --- Q3: Follow-up ---
	const followUpOptions = computed(() => {
		const { symbol } = primary.value;

		return [
			{
				value: "first_only" as const,
				label: "First alert only",
				example: `Once we text you about ${symbol}, we won't notify you again for this asset until the next trading day.`,
			},
			{
				value: "allow_follow_up" as const,
				label: "Allow one follow-up",
				example: `If ${symbol}'s move accelerates later the same day, or reverses (e.g. drops then recovers), we will send one follow-up. Max two alerts per asset per day.`,
			},
		];
	});

	return {
		loading,
		marketContextOptions,
		moveSizeOptions,
		followUpOptions,
	};
}
