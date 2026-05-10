<template>
	<span
		class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium tracking-tight whitespace-nowrap"
		:class="toneClasses"
	>
		{{ label }}
		<span class="text-[0.7rem] leading-none" aria-hidden="true">{{ emoji }}</span>
	</span>
</template>

<script lang="ts" setup>
import { computed } from "vue";

const props = defineProps<{
	session: "pre" | "after";
}>();

const label = computed(() =>
	props.session === "pre" ? "pre-market" : "after-hours",
);

const emoji = computed(() => (props.session === "pre" ? "\u{1F305}" : "\u{1F319}"));

const toneClasses = computed(() =>
	props.session === "pre"
		? "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/50 dark:text-amber-200"
		: "border-indigo-200 bg-indigo-50 text-indigo-900 dark:border-indigo-800/60 dark:bg-indigo-950/50 dark:text-indigo-200",
);
</script>
