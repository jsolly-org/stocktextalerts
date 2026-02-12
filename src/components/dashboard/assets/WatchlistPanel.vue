<template>
	<section class="card relative">
		<FadeTransition>
			<div
				v-if="statusMessage"
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
				class="text-xl sm:text-2xl font-bold text-gray-900"
			>
				My Watchlist
			</h2>
			<span
				class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700"
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
					:input-aria-described-by="assetSearchInputDescribedBy"
					@select="handleSelect"
				/>
				<p
					:id="ASSET_SEARCH_HINT_ID"
					class="mt-2 text-sm text-gray-600"
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
			<div v-if="draftAssets.length === 0" class="relative overflow-hidden text-center py-10 px-4 sm:py-12 sm:px-6 bg-linear-to-b from-gray-50 to-white rounded-xl border-2 border-dashed border-gray-200">
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
				<p class="relative text-sm text-gray-500">
					No assets tracked yet. Use the search above to add your first asset.
				</p>
			</div>
			<ul v-else class="space-y-2" role="list">
				<li
					v-for="asset in draftAssets"
					:key="asset.symbol"
					class="group flex items-center justify-between gap-3 p-3 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors"
				>
					<span class="min-w-0 flex items-center gap-2 text-sm font-medium text-gray-900 truncate">
						<span
							class="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium shrink-0"
							:class="
								asset.type === 'etf'
									? 'bg-purple-100 text-purple-700'
									: 'bg-blue-100 text-blue-700'
							"
						>
							{{ asset.type === "etf" ? "ETF" : "Stock" }}
						</span>
						<span class="truncate">
							<span class="font-semibold">{{ asset.symbol }}</span>
							<span class="text-gray-500"> · {{ asset.name }}</span>
						</span>
					</span>
					<button
						type="button"
						class="btn-icon-danger p-1.5"
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
import type { AssetSearchResult } from "./AssetInput.vue";
import AssetInput from "./AssetInput.vue";
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

const trackedAssetsValue = computed(() =>
	JSON.stringify(draftAssets.value.map((s) => s.symbol)),
);

const isAtAssetLimit = computed(
	() => draftAssets.value.length >= MAX_TRACKED_ASSETS,
);

const ASSET_LIMIT_HINT_ID = "asset-limit-hint";
const ASSET_SEARCH_HINT_ID = "asset-search-hint";

const assetSearchInputDescribedBy = computed(() =>
	isAtAssetLimit.value
		? `${ASSET_SEARCH_HINT_ID} ${ASSET_LIMIT_HINT_ID}`
		: ASSET_SEARCH_HINT_ID,
);

const WORD_CLOUD_TICKERS = [
	{ symbol: "AAPL", style: "top: 8%; left: 5%", size: "text-lg", rotate: "-rotate-12", color: "text-gray-300" },
	{ symbol: "NVDA", style: "top: 5%; left: 35%", size: "text-sm", rotate: "rotate-6", color: "text-gray-200" },
	{ symbol: "TSLA", style: "top: 12%; left: 70%", size: "text-xl", rotate: "-rotate-6", color: "text-gray-300" },
	{ symbol: "SPY", style: "top: 18%; left: 88%", size: "text-xs", rotate: "rotate-12", color: "text-gray-200" },
	{ symbol: "MSFT", style: "top: 30%; left: 2%", size: "text-sm", rotate: "rotate-3", color: "text-gray-300" },
	{ symbol: "AMZN", style: "top: 35%; left: 22%", size: "text-2xl", rotate: "-rotate-3", color: "text-gray-200" },
	{ symbol: "META", style: "top: 45%; left: 55%", size: "text-base", rotate: "-rotate-6", color: "text-gray-300" },
	{ symbol: "JPM", style: "top: 28%; left: 80%", size: "text-sm", rotate: "rotate-12", color: "text-gray-200" },
	{ symbol: "GOOGL", style: "top: 60%; left: 8%", size: "text-xl", rotate: "rotate-6", color: "text-gray-300" },
	{ symbol: "V", style: "top: 55%; left: 42%", size: "text-sm", rotate: "-rotate-6", color: "text-gray-200" },
	{ symbol: "NFLX", style: "top: 68%; left: 65%", size: "text-lg", rotate: "rotate-3", color: "text-gray-300" },
	{ symbol: "AMD", style: "top: 58%; left: 85%", size: "text-xs", rotate: "-rotate-12", color: "text-gray-200" },
	{ symbol: "DIS", style: "top: 82%; left: 15%", size: "text-base", rotate: "-rotate-3", color: "text-gray-200" },
	{ symbol: "QQQ", style: "top: 78%; left: 48%", size: "text-sm", rotate: "rotate-12", color: "text-gray-300" },
	{ symbol: "BA", style: "top: 85%; left: 75%", size: "text-lg", rotate: "-rotate-6", color: "text-gray-200" },
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
		{ symbol: result.symbol, name: result.name, type: result.type },
	];
}

function removeSymbol(symbol: string) {
	draftAssets.value = draftAssets.value.filter((s) => s.symbol !== symbol);
}
</script>
