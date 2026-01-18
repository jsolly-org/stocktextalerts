<template>
	<div ref="panelRef" class="mb-6 bg-white rounded-lg shadow-sm border border-gray-200 p-6">
		<h2 class="text-2xl font-bold text-gray-900 mb-4">Tracked Stocks</h2>
		<input type="hidden" name="tracked_stocks" :value="trackedStocksValue" />

		<div class="mb-6">
			<h3 class="text-lg font-semibold text-gray-900 mb-3">Add Stock</h3>
			<StockInput
				:stock-options="stockOptions"
				@select="handleSelect"
			/>
			<p v-if="hasUnsavedChanges" class="mt-3 text-sm text-amber-700">
				Changes aren’t saved until you click <span class="font-medium">Save Preferences</span> at the bottom of the page.
			</p>
		</div>

		<div>
			<h3 class="text-lg font-semibold text-gray-900 mb-3">Your Stocks</h3>
			<p v-if="draftSymbols.length === 0" class="text-gray-500">
				No stocks tracked yet. Add your first stock above.
			</p>
			<div v-else class="space-y-2">
				<div
					v-for="symbol in draftSymbols"
					:key="symbol"
					class="flex items-center justify-between p-3 bg-gray-50 rounded-lg"
				>
					<span class="font-medium text-gray-900">{{ symbol }}</span>
					<button
						type="button"
						class="px-3 py-1 text-sm bg-red-100 text-red-700 rounded hover:bg-red-200 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
						@click="removeSymbol(symbol)"
					>
						Remove
					</button>
				</div>
			</div>
		</div>
	</div>
</template>

<script lang="ts" setup>
import { computed, onMounted, ref, watch } from "vue";

import StockInput, { type StockOption } from "./StockInput.vue";

interface Props {
	stockOptions: StockOption[];
	initialSymbols: string[];
}

const props = defineProps<Props>();

const draftSymbols = ref([...props.initialSymbols]);
const panelRef = ref<HTMLElement | null>(null);
const formElement = ref<HTMLFormElement | null>(null);

const hasUnsavedChanges = computed(() => {
	if (draftSymbols.value.length !== props.initialSymbols.length) return true;
	const initialSet = new Set(props.initialSymbols);
	return draftSymbols.value.some((symbol) => !initialSet.has(symbol));
});

const trackedStocksValue = computed(() =>
	JSON.stringify(draftSymbols.value),
);

watch(
	draftSymbols,
	() => {
	formElement.value?.dispatchEvent(new Event("input", { bubbles: true }));
	},
	{ flush: "post" },
);

const handleSelect = (symbol: string) => {
	if (!symbol) {
		return;
	}

	if (draftSymbols.value.includes(symbol)) {
		return;
	}

	draftSymbols.value = [...draftSymbols.value, symbol];
};

const removeSymbol = (symbol: string) => {
	draftSymbols.value = draftSymbols.value.filter(
		(current) => current !== symbol,
	);
};

onMounted(() => {
	if (!panelRef.value) {
		return;
	}
	const closestForm = panelRef.value.closest("form");
	if (closestForm instanceof HTMLFormElement) {
		formElement.value = closestForm;
	}
});
</script>


