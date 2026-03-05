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
	return `$${n.toFixed(2).replace(/\.00$/, "")}`;
}

/**
 * Pick a high-priced and low-priced asset for move size examples.
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
	priceAlertsEnabled: Ref<boolean>,
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

	// Fetch lazily when price alerts become enabled
	watch(
		priceAlertsEnabled,
		(enabled) => {
			if (enabled) fetchPrices();
		},
		{ immediate: true },
	);

	const moveSizeOptions = computed(() => {
		const { hi, lo } = pickHighLowPair(trackedAssets.value, prices.value);

		function describeAsset(
			asset: DemoAsset,
			isHighPriced: boolean,
			percentThreshold: number,
			dollarThreshold: number,
		): string {
			const pctDollar = asset.prevClose * (percentThreshold / 100);
			const priceLabel = isHighPriced ? "higher-priced" : "lower-priced";
			return `For ${priceLabel} stocks like ${asset.symbol} (${formatDollar(asset.prevClose)}), alerts trigger on ${percentThreshold}% (~${formatDollar(pctDollar)}) or ${formatDollar(dollarThreshold)}, whichever comes first.`;
		}

		function describeThreshold(tier: "significant" | "extreme"): string {
			const { percentThreshold, dollarThreshold } = MOVE_SIZE_THRESHOLDS[tier];

			const hiLine = describeAsset(hi, true, percentThreshold, dollarThreshold);
			const loLine = describeAsset(
				lo,
				false,
				percentThreshold,
				dollarThreshold,
			);
			return `${hiLine}\n${loLine}`;
		}

		return [
			{
				value: "significant" as const,
				label: "Significant",
				example: describeThreshold("significant"),
			},
			{
				value: "extreme" as const,
				label: "Extreme",
				example: describeThreshold("extreme"),
			},
		];
	});

	return {
		loading,
		moveSizeOptions,
	};
}
