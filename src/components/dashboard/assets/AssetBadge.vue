<template>
	<span
		v-if="type === 'etf'"
		class="inline-flex items-center justify-center rounded font-medium shrink-0 bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300"
		:class="sizeClasses"
	>
		ETF
	</span>
	<img
		v-else-if="iconUrl && !imgFailed"
		ref="imgRef"
		:src="`/api/assets/logo/${encodeURIComponent(symbol)}`"
		:alt="`${symbol} logo`"
		loading="lazy"
		class="shrink-0 rounded object-contain"
		:class="imgSizeClasses"
		@error="imgFailed = true"
	/>
	<span
		v-else
		class="inline-flex items-center justify-center rounded font-medium shrink-0 bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300"
		:class="sizeClasses"
	>
		Stock
	</span>
</template>

<script lang="ts" setup>
import { computed, onMounted, ref, useTemplateRef, watch } from "vue";

interface Props {
	type: "stock" | "etf";
	symbol: string;
	iconUrl: string | null;
	size?: "compact" | "default";
}

const props = withDefaults(defineProps<Props>(), {
	size: "default",
});

const imgFailed = ref(false);
const imgRef = useTemplateRef<HTMLImageElement>("imgRef");

// Catch images that errored before Vue hydration attached the @error handler
onMounted(() => {
	const el = imgRef.value;
	if (el?.complete && el.naturalWidth === 0) {
		imgFailed.value = true;
	}
});

// Reset failure state when the icon URL or symbol changes (e.g. new asset selected)
watch(
	() => [props.iconUrl, props.symbol],
	() => {
		imgFailed.value = false;
	},
);

const sizeClasses = computed(() =>
	props.size === "compact"
		? "size-5 text-[0.5rem]"
		: "size-6 text-[0.5rem]",
);

const imgSizeClasses = computed(() =>
	props.size === "compact" ? "size-5" : "size-6",
);
</script>
