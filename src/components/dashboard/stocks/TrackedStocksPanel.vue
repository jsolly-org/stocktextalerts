<template>
	<div class="mb-6 bg-white rounded-lg shadow-sm border border-gray-200 p-6">
		<h2 class="text-2xl font-bold text-gray-900 mb-4">Tracked Stocks</h2>
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
import { computed, ref, watch } from "vue";
import StockInput, { type StockOption } from "./StockInput.vue";

interface Props {
	stockOptions: StockOption[];
	initialSymbols: string[];
	onFormChanged: () => void;
}

const props = defineProps<Props>();

const draftSymbols = ref([...props.initialSymbols]);

const trackedStocksValue = computed(() =>
	JSON.stringify(draftSymbols.value),
);

watch(
	draftSymbols,
	() => {
		props.onFormChanged();
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

</script>


