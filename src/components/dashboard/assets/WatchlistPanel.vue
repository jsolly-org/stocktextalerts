<template>
	<section class="card relative">
		<FadeTransition>
			<div
				v-if="statusMessage && statusTone === 'error'"
				:id="DASHBOARD_ASSETS_STATUS_ID"
				class="absolute top-3 right-3 flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium z-10"
				:class="[statusTone === 'error' ? 'bg-error-bg text-error-text' : 'bg-info-bg text-info-text']"
				role="status"
				aria-live="polite"
				:aria-busy="isSaving"
				:data-tone="statusTone"
			>
				<ArrowPathIcon
					v-show="isSaving"
					class="animate-spin size-3 shrink-0"
					aria-hidden="true"
					focusable="false"
				/>
				{{ statusMessage }}
			</div>
		</FadeTransition>

		<div :class="`card-accent ${CARD_GRADIENT_ACCENTS.teal}`"></div>
		<div class="card-body">
		<header class="flex items-center gap-2 mb-4">
			<h2
				:id="DASHBOARD_SECTION_IDS.assets"
				class="text-xl sm:text-2xl font-bold text-heading"
			>
				My Watchlist
			</h2>
			<span
				class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-surface-active text-label"
				:aria-label="`${draftAssets.length} ${draftAssets.length === 1 ? 'asset' : 'assets'} tracked`"
			>
				{{ draftAssets.length }}
			</span>
		</header>

		<div v-if="flashMessages.length" class="space-y-2 mb-4">
			<StatusMessage
				v-for="(flash, index) in flashMessages"
				:key="index"
				:tone="flash.tone"
			>
				{{ flash.message }}
			</StatusMessage>
		</div>

		<input type="hidden" name="tracked_assets" :value="trackedAssetsValue" />

		<fieldset class="mb-2">
			<legend class="sr-only">Add to watchlist</legend>
			<div>
				<label for="asset_search" class="sr-only">Search by symbol or company name</label>
				<AssetInput
					:disabled="isAtAssetLimit"
					:disabled-title="assetInputDisabledTitle"
					:input-aria-described-by="assetSearchInputDescribedBy"
					@select="handleSelect"
				/>
				<p
					:id="ASSET_SEARCH_HINT_ID"
					class="mt-2 text-sm text-body-secondary"
				>
					Search by ticker or company name to add to your watchlist.
				</p>
				<p
					v-if="isAtAssetLimit"
					:id="ASSET_LIMIT_HINT_ID"
					class="mt-2 text-sm text-warning-text"
				>
					You've reached the maximum of {{ MAX_TRACKED_ASSETS }} assets. Please remove an existing asset to track a new one.
				</p>
			</div>
		</fieldset>

		<section :aria-label="`${draftAssets.length} tracked ${draftAssets.length === 1 ? 'asset' : 'assets'}`">
			<div v-if="draftAssets.length === 0" class="relative overflow-hidden text-center py-10 px-4 sm:py-12 sm:px-6 bg-linear-to-b from-surface-alt to-surface rounded-xl border-2 border-dashed border-edge">
				<!-- Decorative ticker word cloud -->
				<div class="absolute inset-0 pointer-events-none select-none" aria-hidden="true">
					<span
						v-for="ticker in WORD_CLOUD_TICKERS"
						:key="ticker.symbol"
						class="absolute font-semibold"
						:class="[ticker.size, ticker.rotate, ticker.color]"
						:style="ticker.style"
					>
						{{ ticker.symbol }}
					</span>
				</div>
			<p class="relative text-sm font-medium text-body-secondary" style="text-shadow: 0 0 8px var(--color-surface), 0 0 16px var(--color-surface), 0 0 28px var(--color-surface), 0 0 40px var(--color-surface);">
				No assets tracked yet. Use the search above to add your first asset.
			</p>
			</div>
			<ul v-else class="space-y-2" role="list">
				<li
					v-for="asset in draftAssets"
					:key="asset.symbol"
					class="group flex items-center gap-3 p-3 bg-surface-alt rounded-lg hover:bg-surface-active transition-colors"
				>
					<span class="min-w-0 flex-1 flex items-center gap-2 text-sm font-medium text-heading">
						<AssetBadge :type="asset.type as 'stock' | 'etf'" :symbol="asset.symbol" :icon-url="asset.icon_url" />
						<span class="min-w-0">
							<span class="font-semibold block">{{ asset.symbol }}</span>
							<span class="text-xs text-muted truncate block">{{ asset.name }}</span>
						</span>
					</span>
					<SparklineSvg
						v-if="sparklines.get(asset.symbol)"
						class="hidden sm:block shrink-0 w-12 h-5 opacity-70"
						:values="sparklines.get(asset.symbol) ?? []"
					/>
					<button
						type="button"
						class="btn-icon-danger p-1.5 shrink-0"
						:aria-label="`Remove ${asset.symbol}`"
						@click="removeSymbol(asset.symbol)"
					>
						<XMarkIcon class="size-3.5" aria-hidden="true" focusable="false" />
					</button>
				</li>
			</ul>
		</section>
		</div>
	</section>
</template>

<script lang="ts" setup>
import { computed, ref, toRefs, watch } from "vue";
// ?component suffix required: Astro Icon cannot be used in Vue; vite-svg-loader compiles these to Vue components.
import ArrowPathIcon from "../../../icons/arrow-path.svg?component";
import XMarkIcon from "../../../icons/x-mark.svg?component";
import {
	CARD_GRADIENT_ACCENTS,
	DASHBOARD_ASSETS_STATUS_ID,
	DASHBOARD_SECTION_IDS,
	type FlashMessage,
} from "../../../lib/constants";
import { MAX_TRACKED_ASSETS } from "../../../lib/db/database-errors";
import FadeTransition from "../../FadeTransition.vue";
import StatusMessage from "../../StatusMessage.vue";
import AssetBadge from "./AssetBadge.vue";
import type { AssetSearchResult } from "./AssetInput.vue";
import AssetInput from "./AssetInput.vue";
import SparklineSvg from "./SparklineSvg.vue";
import type { InitialAsset } from "./types";

interface Props {
	initialAssets: InitialAsset[];
	flashMessages?: FlashMessage[];
	statusMessage?: string | null;
	statusTone?: "error" | "info";
	isSaving?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
	flashMessages: () => [],
	statusMessage: null,
	statusTone: "info",
	isSaving: false,
});

const emit = defineEmits<{
	(event: "form-changed"): void;
	(event: "assets-changed", assets: InitialAsset[]): void;
}>();

const { flashMessages, isSaving, statusMessage, statusTone } = toRefs(props);

const draftAssets = ref<InitialAsset[]>([...props.initialAssets]);

const sparklines = ref<Map<string, number[] | null>>(new Map());

async function fetchAllSparklines(symbols: string[]): Promise<void> {
	if (symbols.length === 0) return;
	try {
		const params = `?symbols=${symbols.join(",")}`;
		const res = await fetch(`/api/assets/sparklines${params}`);
		if (!res.ok) return;
		const json = await res.json() as { ok: boolean; sparklines: Record<string, number[] | null> };
		if (!json.ok) return;
		for (const [symbol, values] of Object.entries(json.sparklines)) {
			sparklines.value.set(symbol, values);
		}
	} catch {
		// Sparklines are non-critical; silently ignore fetch failures
	}
}

// Fetch sparklines immediately during setup — avoids hydration-bailout edge cases
// where onMounted on a discarded component writes to an orphaned ref.
if (typeof window !== "undefined") {
	fetchAllSparklines(props.initialAssets.map((a) => a.symbol));
}

const trackedAssetsValue = computed(() =>
	JSON.stringify(draftAssets.value.map((s) => s.symbol)),
);

const isAtAssetLimit = computed(
	() => draftAssets.value.length >= MAX_TRACKED_ASSETS,
);

const assetInputDisabledTitle = computed<string | undefined>(() =>
	isAtAssetLimit.value
		? `You've reached the maximum of ${MAX_TRACKED_ASSETS} tracked assets. Remove one to add another.`
		: undefined,
);

const ASSET_LIMIT_HINT_ID = "asset-limit-hint";
const ASSET_SEARCH_HINT_ID = "asset-search-hint";

const assetSearchInputDescribedBy = computed(() =>
	isAtAssetLimit.value
		? `${ASSET_SEARCH_HINT_ID} ${ASSET_LIMIT_HINT_ID}`
		: ASSET_SEARCH_HINT_ID,
);

const WORD_CLOUD_TICKERS = [
	{ symbol: "AAPL", style: "top: 8%; left: 5%", size: "text-lg", rotate: "-rotate-12", color: "text-edge-strong" },
	{ symbol: "NVDA", style: "top: 5%; left: 35%", size: "text-sm", rotate: "rotate-6", color: "text-edge" },
	{ symbol: "TSLA", style: "top: 12%; left: 70%", size: "text-xl", rotate: "-rotate-6", color: "text-edge-strong" },
	{ symbol: "SPY", style: "top: 18%; left: 88%", size: "text-xs", rotate: "rotate-12", color: "text-edge" },
	{ symbol: "MSFT", style: "top: 30%; left: 2%", size: "text-sm", rotate: "rotate-3", color: "text-edge-strong" },
	{ symbol: "AMZN", style: "top: 35%; left: 22%", size: "text-2xl", rotate: "-rotate-3", color: "text-edge" },
	{ symbol: "META", style: "top: 45%; left: 55%", size: "text-base", rotate: "-rotate-6", color: "text-edge-strong" },
	{ symbol: "JPM", style: "top: 28%; left: 80%", size: "text-sm", rotate: "rotate-12", color: "text-edge" },
	{ symbol: "GOOGL", style: "top: 60%; left: 8%", size: "text-xl", rotate: "rotate-6", color: "text-edge-strong" },
	{ symbol: "V", style: "top: 55%; left: 42%", size: "text-sm", rotate: "-rotate-6", color: "text-edge" },
	{ symbol: "NFLX", style: "top: 68%; left: 65%", size: "text-lg", rotate: "rotate-3", color: "text-edge-strong" },
	{ symbol: "AMD", style: "top: 58%; left: 85%", size: "text-xs", rotate: "-rotate-12", color: "text-edge" },
	{ symbol: "DIS", style: "top: 82%; left: 15%", size: "text-base", rotate: "-rotate-3", color: "text-edge" },
	{ symbol: "QQQ", style: "top: 78%; left: 48%", size: "text-sm", rotate: "rotate-12", color: "text-edge-strong" },
	{ symbol: "BA", style: "top: 85%; left: 75%", size: "text-lg", rotate: "-rotate-6", color: "text-edge" },
] as const;

watch(
	draftAssets,
	(assets) => {
		emit("form-changed");
		emit("assets-changed", assets);
	},
	{ flush: "post", deep: true },
);

function handleSelect(result: AssetSearchResult) {
	if (!result.symbol) {
		return;
	}

	if (draftAssets.value.some((s) => s.symbol === result.symbol)) {
		return;
	}

	draftAssets.value = [
		...draftAssets.value,
		{ symbol: result.symbol, name: result.name, type: result.type, icon_url: result.icon_url },
	];

	fetchAllSparklines([result.symbol]);
}

function removeSymbol(symbol: string) {
	draftAssets.value = draftAssets.value.filter((s) => s.symbol !== symbol);
	sparklines.value.delete(symbol);
}
</script>
