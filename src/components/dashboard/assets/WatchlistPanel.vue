<template>
	<section class="card relative mb-6">
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

		<div :class="`h-1 ${CARD_GRADIENT_ACCENTS.teal}`"></div>
		<div class="card-body">
		<header class="flex items-center gap-2 mb-4">
			<h2
				:id="DASHBOARD_SECTION_IDS.assets"
				class="text-xl sm:text-2xl font-bold text-gray-900"
			>
				Watchlist
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

		<fieldset class="mb-6">
			<legend class="sr-only">Add to watchlist</legend>
			<div>
				<label for="asset_search" class="sr-only">Search by symbol or company name</label>
				<AssetInput
					:asset-options="assetOptions"
					:disabled="isAtAssetLimit"
					:input-aria-described-by="isAtAssetLimit ? ASSET_LIMIT_HINT_ID : undefined"
					@select="handleSelect"
				/>
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
			<div v-if="draftAssets.length === 0" class="text-center py-10 px-4 sm:py-12 sm:px-6 bg-linear-to-b from-gray-50 to-white rounded-xl border-2 border-dashed border-gray-200">
				<div class="mx-auto h-12 w-12 flex items-center justify-center rounded-full bg-gray-100">
					<ChartBarIcon class="h-6 w-6 text-gray-400" aria-hidden="true" focusable="false" />
				</div>
				<p class="mt-3 text-sm text-gray-500">Search above to add assets.</p>
			</div>
			<ul v-else class="space-y-2" role="list">
				<li
					v-for="asset in draftAssets"
					:key="asset.symbol"
					class="group flex items-center justify-between gap-3 p-3 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors"
				>
					<span class="min-w-0 text-sm font-medium text-gray-900 truncate">
						<span class="font-semibold">{{ asset.symbol }}</span>
						<span class="text-gray-500"> · {{ asset.name }}</span>
					</span>
					<button
						type="button"
						class="btn-icon-danger rounded p-1.5"
						:aria-label="`Remove ${asset.symbol}`"
						@click="removeSymbol(asset.symbol)"
					>
						<XMarkIcon class="h-4 w-4" aria-hidden="true" focusable="false" />
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
import ChartBarIcon from "../../../icons/chart-bar.svg?component";
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
import type { AssetOption } from "./AssetInput.vue";
import AssetInput from "./AssetInput.vue";
import type { InitialAsset } from "./types";

interface Props {
	assetOptions: AssetOption[];
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

watch(
	draftAssets,
	(assets) => {
		emit("form-changed");
		emit("assets-changed", assets);
	},
	{ flush: "post", deep: true },
);

function nameForSymbol(symbol: string): string {
	const option = props.assetOptions.find((o) => o.value === symbol);
	if (!option?.label.includes(" - ")) {
		return symbol;
	}
	return option.label.split(" - ").slice(1).join(" - ");
}

function handleSelect(symbol: string) {
	if (!symbol) {
		return;
	}

	if (draftAssets.value.some((s) => s.symbol === symbol)) {
		return;
	}

	draftAssets.value = [
		...draftAssets.value,
		{ symbol, name: nameForSymbol(symbol) },
	];
}

function removeSymbol(symbol: string) {
	draftAssets.value = draftAssets.value.filter((s) => s.symbol !== symbol);
}
</script>


