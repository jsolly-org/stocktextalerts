<template>
	<div class="mb-6 bg-white rounded-lg shadow-md border border-gray-200 overflow-hidden">
		<div :class="`h-1 ${CARD_GRADIENT_ACCENTS.teal}`"></div>
		<div class="p-6">
		<h2
			:id="DASHBOARD_SECTION_IDS.stocks"
			class="text-2xl font-bold text-gray-900 mb-2"
		>
			Tracked Stocks
		</h2>

		<div v-if="flashMessages.length" class="space-y-2 mb-4">
			<StatusMessage
				v-for="(flash, index) in flashMessages"
				:key="index"
				:tone="flash.tone"
			>
				{{ flash.message }}
			</StatusMessage>
		</div>

		<div class="min-h-5 mb-4">
			<Transition
				enter-active-class="transition-opacity duration-150"
				enter-from-class="opacity-0"
				enter-to-class="opacity-100"
				leave-active-class="transition-opacity duration-150"
				leave-from-class="opacity-100"
				leave-to-class="opacity-0"
			>
				<p
					v-if="statusMessage"
					:id="DASHBOARD_STOCKS_STATUS_ID"
					class="text-sm flex items-center gap-2"
					:class="[statusTone === 'error' ? 'text-error-text' : 'text-info-text']"
					role="status"
					aria-live="polite"
					:aria-busy="isSaving"
					:data-tone="statusTone"
				>
					<ArrowPathIcon
						v-show="isSaving"
						class="animate-spin size-4 shrink-0"
						aria-hidden="true"
					/>
					{{ statusMessage }}
				</p>
			</Transition>
		</div>

		<input type="hidden" name="tracked_stocks" :value="trackedStocksValue" />

		<div class="mb-6">
			<h3 class="text-lg font-semibold text-gray-900 mb-3">Add Stock</h3>
			<StockInput
				:stock-options="stockOptions"
				@select="handleSelect"
			/>
		</div>

		<div>
			<h3 class="text-lg font-semibold text-gray-900 mb-3">Your Stocks</h3>
			<div v-if="draftSymbols.length === 0" class="text-center py-8 px-4 bg-gray-50 rounded-lg border-2 border-dashed border-gray-200">
				<ChartBarIcon class="mx-auto h-12 w-12 text-gray-400" aria-hidden="true" />
				<h4 class="mt-4 text-sm font-semibold text-gray-900">No stocks tracked yet</h4>
				<p class="mt-1 text-sm text-gray-500">
					Get started by adding your first stock ticker above.
				</p>
			</div>
			<div v-else class="space-y-2">
				<div
					v-for="symbol in draftSymbols"
					:key="symbol"
					class="flex items-center justify-between p-3 bg-gray-50 rounded-lg"
				>
					<span class="font-medium text-gray-900">{{ symbol }}</span>
					<button
						type="button"
						class="px-3 py-1 text-sm bg-error-bg text-error-text rounded hover:bg-error-border transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
						@click="removeSymbol(symbol)"
					>
						Remove
					</button>
				</div>
			</div>
		</div>
		</div>
	</div>
</template>

<script lang="ts" setup>
import { computed, ref, toRefs, watch } from "vue";
// ?component suffix required: Astro Icon cannot be used in Vue; vite-svg-loader compiles these to Vue components.
import ArrowPathIcon from "../../../icons/arrow-path.svg?component";
import ChartBarIcon from "../../../icons/chart-bar.svg?component";
import {
	CARD_GRADIENT_ACCENTS,
	DASHBOARD_SECTION_IDS,
	DASHBOARD_STOCKS_STATUS_ID,
} from "../../../lib/constants";
import StatusMessage from "../../StatusMessage.vue";
import type { StockOption } from "./StockInput.vue";
import StockInput from "./StockInput.vue";

interface Props {
	stockOptions: StockOption[];
	initialSymbols: string[];
	onFormChanged: () => void;
	flashMessages?: { tone: "success" | "error" | "warning"; message: string }[];
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

const { flashMessages, isSaving, statusMessage, statusTone } = toRefs(props);

const draftSymbols = ref([...props.initialSymbols]);

const trackedStocksValue = computed(() => JSON.stringify(draftSymbols.value));

watch(
	draftSymbols,
	() => {
		props.onFormChanged();
	},
	{ flush: "post" },
);

function handleSelect(symbol: string) {
	if (!symbol) {
		return;
	}

	if (draftSymbols.value.includes(symbol)) {
		return;
	}

	draftSymbols.value = [...draftSymbols.value, symbol];
}

function removeSymbol(symbol: string) {
	draftSymbols.value = draftSymbols.value.filter(
		(current) => current !== symbol,
	);
}
</script>


