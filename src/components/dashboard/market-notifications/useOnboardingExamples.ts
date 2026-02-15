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
	// --- Q1: Risk Priority ---
	const riskPriorityOptions = computed(() => {
		const { symbol, prevClose } = primary.value;
		const pct = 5;
		const dropPrice = (prevClose * (1 - pct / 100)).toFixed(2);
		const gainPrice = (prevClose * (1 + pct / 100)).toFixed(2);

		return [
			{
				value: "big_drops" as const,
				label: "Big drops",
				example: `${symbol} falls from $${prevClose} \u2192 $${dropPrice} (\u2212${pct}%) \u2014 you'd get a text.`,
			},
			{
				value: "big_gains" as const,
				label: "Big gains",
				example: `${symbol} rises from $${prevClose} \u2192 $${gainPrice} (+${pct}%) \u2014 you'd get a text.`,
			},
			{
				value: "both_equally" as const,
				label: "Both equally",
				example: `${symbol} moves \u00B1${pct}% from $${prevClose} \u2014 you'd get a text either way.`,
			},
		];
	});

	// --- Q2: Market Context ---
	const marketContextOptions = computed(() => {
		const { symbol, sector } = primary.value;
		const peers = sectorPeerLabel(sector);

		return [
			{
				value: "any_major" as const,
				label: "Any big move",
				example: `${symbol} drops 5% on a day ${peers} are also down 4% \u2014 you'd still get a text.`,
			},
			{
				value: "standout" as const,
				label: "Only standouts",
				example: `${symbol} drops 5% while ${peers} only drop 2% \u2014 you'd get a text because ${symbol} is an outlier. If all dropped ~5%, we'd skip it.`,
			},
			{
				value: "extreme_only" as const,
				label: "Extreme only",
				example: `We'd only text you if ${symbol} moves dramatically beyond ${peers} \u2014 like \u221210% when they're down 2%.`,
			},
		];
	});

	// --- Q3: Move Size ---
	const moveSizeOptions = computed(() => {
		const { hi, lo } = pickHighLowPair(trackedAssets.value, prices.value);

		function describeThreshold(
			tier: "moderate" | "large" | "very_large",
		): string {
			const { percentThreshold, dollarThreshold } = MOVE_SIZE_THRESHOLDS[tier];
			const hiDollar = hi.prevClose * (percentThreshold / 100);
			const loDollar = lo.prevClose * (percentThreshold / 100);

			const hiTrigger =
				hiDollar >= dollarThreshold
					? `alerts at ~${formatDollar(hiDollar)} move (${percentThreshold}%)`
					: `alerts at ${formatDollar(dollarThreshold)} move (${formatDollar(dollarThreshold)} floor > ${percentThreshold}%)`;

			const loTrigger =
				loDollar >= dollarThreshold
					? `alerts at ~${formatDollar(loDollar)} move (${percentThreshold}%)`
					: `alerts at ${formatDollar(dollarThreshold)} move (${formatDollar(dollarThreshold)} floor > ${percentThreshold}%)`;

			return `${hi.symbol} ($${hi.prevClose}) \u2014 ${hiTrigger}\n${lo.symbol} ($${lo.prevClose}) \u2014 ${loTrigger}`;
		}

		return [
			{
				value: "very_large" as const,
				label: "Very large only",
				example: describeThreshold("very_large"),
			},
			{
				value: "large" as const,
				label: "Large",
				example: describeThreshold("large"),
			},
			{
				value: "moderate" as const,
				label: "Moderate but meaningful",
				example: describeThreshold("moderate"),
			},
		];
	});

	// --- Q4: Follow-up ---
	const followUpOptions = computed(() => {
		const { symbol } = primary.value;

		return [
			{
				value: "first_only" as const,
				label: "First move only",
				example: `Once we text you about ${symbol}, we wait until the next trading day.`,
			},
			{
				value: "allow_acceleration_follow_up" as const,
				label: "Alert on acceleration",
				example: `If ${symbol}'s drop accelerates from \u22125% to \u22128% later the same day, we send one follow-up.`,
			},
			{
				value: "allow_recovery_follow_up" as const,
				label: "Alert on recovery",
				example: `If ${symbol} drops 5% and then recovers back near flat, we send one follow-up so you know the spike reversed.`,
			},
		];
	});

	return {
		loading,
		riskPriorityOptions,
		marketContextOptions,
		moveSizeOptions,
		followUpOptions,
	};
}
