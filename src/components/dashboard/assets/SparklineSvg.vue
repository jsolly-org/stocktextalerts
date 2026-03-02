<template>
	<svg
		viewBox="0 0 60 24"
		:class="colorClass"
		aria-hidden="true"
		focusable="false"
	>
		<polyline
			:points="points"
			fill="none"
			stroke="currentColor"
			stroke-width="1.5"
			stroke-linecap="round"
			stroke-linejoin="round"
		/>
	</svg>
</template>

<script lang="ts" setup>
import { computed } from "vue";

interface Props {
	values: number[];
}

const props = defineProps<Props>();

const WIDTH = 60;
const HEIGHT = 24;
const PAD_Y = 2;

const colorClass = computed(() => {
	const v = props.values;
	if (v.length < 2) return "text-muted";
	return v[v.length - 1] >= v[0] ? "text-emerald-600" : "text-red-500";
});

const points = computed(() => {
	const v = props.values;
	if (v.length < 2) return "";

	const min = Math.min(...v);
	const max = Math.max(...v);
	const range = max - min || 1;

	const usableHeight = HEIGHT - PAD_Y * 2;
	const stepX = WIDTH / (v.length - 1);

	return v
		.map((val, i) => {
			const x = i * stepX;
			const y = PAD_Y + usableHeight - ((val - min) / range) * usableHeight;
			return `${x.toFixed(1)},${y.toFixed(1)}`;
		})
		.join(" ");
});
</script>
