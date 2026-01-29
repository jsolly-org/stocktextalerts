<template>
	<section class="card relative mb-6">
		<Transition
			enter-active-class="transition-opacity duration-150"
			enter-from-class="opacity-0"
			enter-to-class="opacity-100"
			leave-active-class="transition-opacity duration-150"
			leave-from-class="opacity-100"
			leave-to-class="opacity-0"
		>
			<div
				v-if="statusMessage"
				:id="DASHBOARD_STOCKS_STATUS_ID"
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
				/>
				{{ statusMessage }}
			</div>
		</Transition>

		<div :class="`h-1 ${CARD_GRADIENT_ACCENTS.teal}`"></div>
		<div class="card-body">
		<header class="mb-4">
			<h2
				:id="DASHBOARD_SECTION_IDS.stocks"
				class="text-2xl font-bold text-gray-900"
			>
				Tracked Stocks
			</h2>
			<p class="text-sm text-gray-600 mt-1">
				Select stocks to include in your daily digest.
			</p>
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

		<input type="hidden" name="tracked_stocks" :value="trackedStocksValue" />

		<fieldset class="mb-6">
			<legend class="sr-only">Stock selection</legend>
			<StockInput
				:stock-options="stockOptions"
				@select="handleSelect"
			/>
		</fieldset>

		<section aria-labelledby="tracked-stocks-list-heading">
			<h3 id="tracked-stocks-list-heading" class="text-lg font-semibold text-gray-900 mb-3">Your Stocks</h3>
			<div v-if="draftStocks.length === 0" class="text-center py-12 px-6 bg-gradient-to-b from-gray-50 to-white rounded-xl border-2 border-dashed border-gray-200">
				<div class="mx-auto h-16 w-16 flex items-center justify-center rounded-full bg-gray-100">
					<ChartBarIcon class="h-8 w-8 text-gray-400" aria-hidden="true" />
				</div>
				<h4 class="mt-4 text-base font-semibold text-gray-900">No stocks tracked yet</h4>
				<p class="mt-2 text-sm text-gray-500 max-w-xs mx-auto">
					Search for stocks above to add them to your daily digest.
				</p>
			</div>
			<ul v-else class="space-y-2">
				<li
					v-for="stock in draftStocks"
					:key="stock.symbol"
					class="flex items-center justify-between p-3 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors"
				>
					<span class="font-medium text-gray-900">{{ stock.symbol }} - {{ stock.name }}</span>
					<button
						type="button"
						class="btn btn-sm btn-ghost text-error-text hover:bg-error-bg hover:text-error-text"
						@click="removeSymbol(stock.symbol)"
					>
						Remove
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
import {
	CARD_GRADIENT_ACCENTS,
	DASHBOARD_SECTION_IDS,
	DASHBOARD_STOCKS_STATUS_ID,
} from "../../../lib/constants";
import StatusMessage from "../../StatusMessage.vue";
import type { StockOption } from "./StockInput.vue";
import StockInput from "./StockInput.vue";
import type { InitialStock } from "./types";

interface Props {
	stockOptions: StockOption[];
	initialStocks: InitialStock[];
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

const draftStocks = ref<InitialStock[]>([...props.initialStocks]);

const trackedStocksValue = computed(() =>
	JSON.stringify(draftStocks.value.map((s) => s.symbol)),
);

watch(
	draftStocks,
	() => {
		props.onFormChanged();
	},
	{ flush: "post", deep: true },
);

function nameForSymbol(symbol: string): string {
	const option = props.stockOptions.find((o) => o.value === symbol);
	if (!option?.label.includes(" - ")) {
		return symbol;
	}
	return option.label.split(" - ").slice(1).join(" - ");
}

function handleSelect(symbol: string) {
	if (!symbol) {
		return;
	}

	if (draftStocks.value.some((s) => s.symbol === symbol)) {
		return;
	}

	draftStocks.value = [
		...draftStocks.value,
		{ symbol, name: nameForSymbol(symbol) },
	];
}

function removeSymbol(symbol: string) {
	draftStocks.value = draftStocks.value.filter((s) => s.symbol !== symbol);
}
</script>


