<template>
	<div class="relative" ref="containerRef">
		<input
			type="text"
			id="asset_search"
			v-model="rawSearchQuery"
			@input="handleInput"
			@keydown="handleKeydown"
			placeholder="Search by symbol or company name…"
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
			v-show="showDropdown && (searchQuery.length >= 1 || filteredAssets.length > 0)"
			role="listbox"
			class="absolute z-50 w-full mt-1 bg-white shadow-lg rounded-lg border border-gray-200 max-h-60 overflow-auto"
		>
			<li
				v-if="isSearching"
				class="px-4 py-2 text-sm text-gray-500"
				role="option"
				aria-disabled="true"
			>
				Searching…
			</li>
			<li
				v-else-if="filteredAssets.length === 0 && searchQuery.length >= 1"
				class="px-4 py-2 text-sm text-gray-500"
				role="option"
				aria-disabled="true"
			>
				No assets found
			</li>
			<li
				v-for="(result, index) in filteredAssets"
				:key="result.item.value"
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
							result.item.type === 'etf'
								? 'bg-purple-100 text-purple-700'
								: 'bg-blue-100 text-blue-700'
						"
					>
						{{ result.item.type === "etf" ? "ETF" : "Stock" }}
					</span>
					<span class="truncate">{{ result.item.label }}</span>
				</span>
			</li>
		</ul>
	</div>
</template>

<script lang="ts" setup>
import { onClickOutside, refDebounced } from "@vueuse/core";
import Fuse from "fuse.js";
import { computed, onMounted, ref, watch } from "vue";

export interface AssetOption {
	value: string;
	label: string;
	type: "stock" | "etf";
}

interface Props {
	assetOptions: AssetOption[];
	disabled?: boolean;
	inputAriaDescribedBy?: string;
}

interface FuseResult {
	item: AssetOption;
}

type KeyActions = {
	ArrowDown: () => void;
	ArrowUp: () => void;
	Enter: () => void;
};

const props = withDefaults(defineProps<Props>(), {
	disabled: false,
});
const emit = defineEmits<(e: "select", symbol: string) => void>();

const selectedAsset = ref<string | null>(null);
const rawSearchQuery = ref("");
const searchQuery = refDebounced(rawSearchQuery, 300);
const isSearching = ref(false);

watch(rawSearchQuery, (newValue) => {
	if (newValue.length >= 1) {
		isSearching.value = true;
	}
});

watch(searchQuery, () => {
	isSearching.value = false;
});

const showDropdown = ref(false);
const highlightedIndex = ref(-1);

const fuse = computed(
	() =>
		new Fuse<AssetOption>(props.assetOptions, {
			keys: ["label", "value"],
			threshold: 0.3,
		}),
);

const filteredAssets = computed(() => {
	if (searchQuery.value.length < 1) return [];
	return fuse.value.search(searchQuery.value).slice(0, 10);
});

const containerRef = ref<HTMLElement | null>(null);

const resetDropdown = () => {
	showDropdown.value = false;
	highlightedIndex.value = -1;
};

onMounted(() => {
	onClickOutside(containerRef, resetDropdown);
});

const selectAsset = (result: FuseResult) => {
	selectedAsset.value = result.item.value;
	rawSearchQuery.value = "";
	resetDropdown();

	emit("select", result.item.value);
};

const handleInput = () => {
	const current = props.assetOptions.find(
		(s) => s.value === selectedAsset.value,
	);
	if (!current || rawSearchQuery.value !== current.label) {
		selectedAsset.value = null;
		showDropdown.value = true;
		highlightedIndex.value = -1;
	}
};

const handleKeydown = (e: KeyboardEvent) => {
	if (e.key === "Escape") {
		e.preventDefault();
		resetDropdown();
		return;
	}

	if (rawSearchQuery.value.length < 1 || filteredAssets.value.length === 0)
		return;

	const maxIndex = filteredAssets.value.length - 1;
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
			const assets = filteredAssets.value;
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

