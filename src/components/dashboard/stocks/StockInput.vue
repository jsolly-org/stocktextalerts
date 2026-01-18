<template>
	<div class="relative" ref="containerRef">
	<input ref="inputRef" type="text" id="stock_search" v-model="rawSearchQuery" @input="handleInput"
		@keydown="handleKeydown" placeholder="Search by symbol or company name..." autocomplete="off" role="combobox"
		aria-haspopup="listbox" :aria-expanded="showDropdown" aria-controls="stock_dropdown" aria-autocomplete="list"
		:aria-activedescendant="highlightedIndex >= 0 ? `stock_option_${highlightedIndex}` : undefined"
		:disabled="props.disabled"
		class="w-full px-4 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-slate-100 disabled:text-slate-500 disabled:cursor-not-allowed"
		@focus="showDropdown = true" />

	<div id="stock_dropdown" v-show="showDropdown && (searchQuery.length >= 1 || filteredStocks.length > 0)" role="listbox"
			class="absolute z-50 w-full mt-1 bg-white shadow-lg rounded-lg border border-slate-200 max-h-60 overflow-auto">
			<div v-if="isSearching" class="px-4 py-2 text-sm text-slate-500">
				Searching...
			</div>
			<div v-else-if="filteredStocks.length === 0 && searchQuery.length >= 1"
				class="px-4 py-2 text-sm text-slate-500">
				No stocks found
			</div>
		<div v-for="(result, index) in filteredStocks" :key="result.item.value" role="option"
			:id="`stock_option_${index}`"
			:aria-selected="highlightedIndex === index" :data-highlighted="highlightedIndex === index"
			@click="selectStock(result)"
			class="w-full px-4 py-2 text-left hover:bg-blue-50 focus:bg-blue-50 focus:outline-none cursor-pointer"
			:class="{ 'bg-blue-100': highlightedIndex === index }">
			{{ result.item.label }}
		</div>
	</div>
</div>
</template>

<script lang="ts" setup>
import { onClickOutside, refDebounced } from "@vueuse/core";
import Fuse from "fuse.js";
import { computed, onMounted, ref, watch } from "vue";

export interface StockOption {
	value: string;
	label: string;
}

interface Props {
	stockOptions: StockOption[];
	disabled?: boolean;
}

interface FuseResult {
	item: StockOption;
	refIndex: number;
	score?: number;
}

type KeyActions = {
	ArrowDown: () => void;
	ArrowUp: () => void;
	Enter: () => void;
};

const props = withDefaults(defineProps<Props>(), {
	disabled: false,
});
const emit = defineEmits<{
	(e: "select", symbol: string): void;
}>();

const selectedStock = ref<string | null>(null);
const rawSearchQuery = ref("");
const searchQuery = refDebounced(rawSearchQuery, 300);
const isSearching = ref(false);

watch(rawSearchQuery, (newValue, oldValue) => {
	if (newValue !== oldValue && newValue.length >= 1) {
		isSearching.value = true;
	}
});

watch(searchQuery, () => {
	isSearching.value = false;
});

const showDropdown = ref(false);
const highlightedIndex = ref(-1);

const fuse = computed(() => new Fuse<StockOption>(props.stockOptions, {
	keys: ["label", "value"],
	threshold: 0.3,
}));

const filteredStocks = computed(() => {
	if (searchQuery.value.length < 1) return [];
	return fuse.value.search(searchQuery.value).slice(0, 10);
});

const containerRef = ref<HTMLElement | null>(null);
const inputRef = ref<HTMLInputElement | null>(null);

const resetDropdown = () => {
	showDropdown.value = false;
	highlightedIndex.value = -1;
};

onMounted(() => {
	onClickOutside(containerRef, resetDropdown);
});

const selectStock = (result: FuseResult) => {
	selectedStock.value = result.item.value;
	rawSearchQuery.value = "";
	resetDropdown();

	emit("select", result.item.value);
};

const handleInput = () => {
	const current = props.stockOptions.find((s) => s.value === selectedStock.value);
	if (!current || rawSearchQuery.value !== current.label) {
		selectedStock.value = null;
		showDropdown.value = true;
		highlightedIndex.value = -1;
	}
};

const handleKeydown = (e: KeyboardEvent) => {
	if (e.key === 'Escape') {
		e.preventDefault();
		resetDropdown();
		return;
	}

	if (rawSearchQuery.value.length < 1 || filteredStocks.value.length === 0) return;

	const maxIndex = filteredStocks.value.length - 1;
	const actions: KeyActions = {
		ArrowDown: () => {
			if (!showDropdown.value) {
				showDropdown.value = true;
				highlightedIndex.value = 0;
				return;
			}
			highlightedIndex.value = Math.min(
				(highlightedIndex.value < 0 ? -1 : highlightedIndex.value) + 1,
				maxIndex
			);
		},
		ArrowUp: () => {
			if (!showDropdown.value) {
				showDropdown.value = true;
				highlightedIndex.value = maxIndex;
				return;
			}
			highlightedIndex.value =
				highlightedIndex.value < 0
					? maxIndex
					: Math.max(highlightedIndex.value - 1, 0);
		},
		Enter: () => {
			const stocks = filteredStocks.value;
			if (!stocks || stocks.length === 0) return;

			const safeIndex = Math.min(
				Math.max(0, highlightedIndex.value),
				stocks.length - 1
			);
			const selected = stocks[safeIndex];
			if (!selected) return;

			selectStock(selected);
		},
	};

	if (actions[e.key as keyof KeyActions]) {
		e.preventDefault();
		actions[e.key as keyof KeyActions]();
	}
};
</script>

