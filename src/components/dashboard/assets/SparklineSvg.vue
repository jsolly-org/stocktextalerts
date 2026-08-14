<template>
	<svg
		viewBox="0 0 60 24"
		:class="colorClass"
		aria-hidden="true"
		focusable="false"
	>
		<polyline
			pathLength="1"
			:points="points"
			fill="none"
			stroke="currentColor"
			stroke-width="1.5"
			stroke-linecap="round"
			stroke-linejoin="round"
			class="sparkline-line"
			:style="drawStyle"
		/>
	</svg>
</template>

<script lang="ts" setup>
import { computed } from "vue";

const DRAW_DURATION_MS = 700;

interface Props {
	values: number[];
	/** Stagger delay from the parent; applied as animation-delay. */
	drawDelayMs?: number;
}

const props = withDefaults(defineProps<Props>(), {
	drawDelayMs: 0,
});

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

const drawStyle = computed(() => ({
	animationDuration: `${DRAW_DURATION_MS}ms`,
	animationDelay: `${Math.max(0, props.drawDelayMs)}ms`,
}));
</script>

<style scoped>
.sparkline-line {
	stroke-dasharray: 1;
	stroke-dashoffset: 0;
	animation: sparkline-draw 700ms cubic-bezier(0.22, 1, 0.36, 1) backwards;
}

@keyframes sparkline-draw {
	from {
		stroke-dashoffset: 1;
	}
}

@media (prefers-reduced-motion: reduce) {
	.sparkline-line {
		animation: none;
	}
}
</style>
