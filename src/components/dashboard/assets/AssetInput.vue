<template>
	<div class="relative" ref="containerRef">
		<input
			type="text"
			id="asset_search"
			v-model="rawSearchQuery"
			@input="handleInput"
			@keydown="handleKeydown"
			placeholder="AAPL, VOO, Tesla, etc"
			autocomplete="off"
			role="combobox"
			aria-haspopup="listbox"
			:aria-expanded="showDropdown"
			aria-controls="asset_dropdown"
			aria-autocomplete="list"
			:aria-activedescendant="
				highlightedIndex >= 0 ? `asset_option_${highlightedIndex}` : undefined
			"
			:aria-describedby="inputAriaDescribedBy"
			:disabled="props.disabled"
			class="input disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
			@focus="showDropdown = true"
		/>

		<ul
			id="asset_dropdown"
			v-show="showDropdown && (searchQuery.length >= 1 || searchResults.length > 0)"
			role="listbox"
			class="absolute z-50 w-full mt-1 bg-surface shadow-lg rounded-lg border border-edge max-h-60 overflow-auto"
		>
			<li
				v-if="isSearching"
				class="px-4 py-2 text-sm text-muted"
				role="option"
				aria-disabled="true"
			>
				Searching…
			</li>
			<li
				v-else-if="searchResults.length === 0 && searchQuery.length >= 1"
				class="px-4 py-2 text-sm text-muted"
				role="option"
				aria-disabled="true"
			>
				No assets found
			</li>
			<li
				v-for="(result, index) in searchResults"
				:key="result.symbol"
				role="option"
				:id="`asset_option_${index}`"
				:aria-selected="highlightedIndex === index"
				:data-highlighted="highlightedIndex === index"
				@click="selectAsset(result)"
				class="w-full px-4 py-2 text-left hover:bg-info-bg focus:bg-info-bg focus:outline-none cursor-pointer"
				:class="{ 'bg-info-border': highlightedIndex === index }"
			>
				<span class="flex items-center gap-2">
					<span
						class="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium shrink-0"
						:class="
							result.type === 'etf'
								? 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300'
								: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300'
						"
					>
						{{ result.type === "etf" ? "ETF" : "Stock" }}
					</span>
					<span class="truncate">{{ result.symbol }} - {{ result.name }}</span>
				</span>
			</li>
		</ul>
	</div>
</template>

<script lang="ts" setup>
import { onClickOutside, refDebounced } from "@vueuse/core";
import { onMounted, ref, watch } from "vue";

export interface AssetSearchResult {
	symbol: string;
	name: string;
	type: "stock" | "etf";
}

interface Props {
	disabled?: boolean;
	inputAriaDescribedBy?: string;
}

type KeyActions = {
	ArrowDown: () => void;
	ArrowUp: () => void;
	Enter: () => void;
};

const props = withDefaults(defineProps<Props>(), {
	disabled: false,
});
const emit = defineEmits<(e: "select", result: AssetSearchResult) => void>();

const rawSearchQuery = ref("");
const searchQuery = refDebounced(rawSearchQuery, 300);
const isSearching = ref(false);
const searchResults = ref<AssetSearchResult[]>([]);

let fetchController: AbortController | null = null;

watch(rawSearchQuery, (newValue) => {
	if (newValue.length === 0) {
		fetchController?.abort();
		searchResults.value = [];
		isSearching.value = false;
		return;
	}

	if (newValue.length >= 1) {
		isSearching.value = true;
	}
});

async function fetchResults(query: string) {
	fetchController?.abort();
	if (query.length < 1) {
		searchResults.value = [];
		isSearching.value = false;
		return;
	}

	fetchController = new AbortController();
	try {
		const params = new URLSearchParams({ q: query, limit: "10" });
		const response = await fetch(`/api/assets/search?${params}`, {
			signal: fetchController.signal,
		});
		if (!response.ok) {
			searchResults.value = [];
			return;
		}
		const data = (await response.json()) as {
			ok: boolean;
			results: AssetSearchResult[];
		};
		searchResults.value = data.results ?? [];
	} catch {
		// Aborted or network error — ignore
	} finally {
		isSearching.value = false;
	}
}

watch(searchQuery, (query) => {
	fetchResults(query);
});

const showDropdown = ref(false);
const highlightedIndex = ref(-1);

const containerRef = ref<HTMLElement | null>(null);

const resetDropdown = () => {
	showDropdown.value = false;
	highlightedIndex.value = -1;
};

onMounted(() => {
	onClickOutside(containerRef, resetDropdown);
});

const selectAsset = (result: AssetSearchResult) => {
	rawSearchQuery.value = "";
	resetDropdown();
	emit("select", result);
};

const handleInput = () => {
	showDropdown.value = true;
	highlightedIndex.value = -1;
};

const handleKeydown = (e: KeyboardEvent) => {
	if (e.key === "Escape") {
		e.preventDefault();
		resetDropdown();
		return;
	}

	if (rawSearchQuery.value.length < 1 || searchResults.value.length === 0)
		return;

	const maxIndex = searchResults.value.length - 1;
	const actions: KeyActions = {
		ArrowDown: () => {
			if (!showDropdown.value) {
				showDropdown.value = true;
				highlightedIndex.value = 0;
				return;
			}
			highlightedIndex.value = Math.min(
				highlightedIndex.value + 1,
				maxIndex,
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
			const assets = searchResults.value;
			if (!assets || assets.length === 0) return;

			const safeIndex = Math.min(
				Math.max(0, highlightedIndex.value),
				assets.length - 1,
			);
			const selected = assets[safeIndex];
			if (!selected) return;

			selectAsset(selected);
		},
	};

	if (e.key in actions) {
		e.preventDefault();
		actions[e.key as keyof KeyActions]();
	}
};
</script>
