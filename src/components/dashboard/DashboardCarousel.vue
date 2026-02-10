<template>
	<div class="dashboard-carousel">
		<!-- Tab bar: only visible on mobile via CSS -->
		<nav class="carousel-tabs" aria-label="Dashboard sections">
			<button
				v-for="(tab, index) in tabs"
				:key="tab.id"
				type="button"
				class="carousel-tab"
				:class="{ 'carousel-tab--active': activeIndex === index }"
				:aria-label="tab.label"
				:aria-current="activeIndex === index ? 'true' : undefined"
				@click="scrollToCard(index)"
			>
				<component :is="tab.icon" class="size-5" aria-hidden="true" />
			</button>
		</nav>

		<div
			ref="trackRef"
			class="carousel-track"
			@scroll.passive="handleScroll"
		>
			<div
				v-for="(tab, index) in tabs"
				:key="tab.id"
				:ref="(el) => setCardRef(el as HTMLElement | null, index)"
				class="carousel-card"
			>
				<div class="carousel-card-inner">
					<slot :name="tab.id" />
				</div>
			</div>
		</div>
	</div>
</template>

<script lang="ts" setup>
import { type Component, onBeforeUnmount, onMounted, ref } from "vue";
import BellAlertIcon from "../../icons/bell-alert.svg?component";
import CalendarDaysIcon from "../../icons/calendar-days.svg?component";
import ClockIcon from "../../icons/clock.svg?component";
import EyeIcon from "../../icons/eye.svg?component";
import PresentationChartLineIcon from "../../icons/presentation-chart-line.svg?component";

interface Tab {
	id: string;
	label: string;
	icon: Component;
}

const tabs: Tab[] = [
	{ id: "setup", label: "Watchlist & Channels", icon: PresentationChartLineIcon },
	{ id: "schedule", label: "Schedule", icon: ClockIcon },
	{ id: "daily", label: "Daily", icon: BellAlertIcon },
	{ id: "weekly", label: "Weekly", icon: CalendarDaysIcon },
	{ id: "preview", label: "Preview", icon: EyeIcon },
];

const activeIndex = ref(0);
const trackRef = ref<HTMLElement | null>(null);
const cardRefs: (HTMLElement | null)[] = [];

function setCardRef(el: HTMLElement | null, index: number) {
	cardRefs[index] = el;
}

function scrollToCard(index: number) {
	const card = cardRefs[index];
	if (card && trackRef.value) {
		trackRef.value.scrollTo({
			left: card.offsetLeft,
			behavior: "smooth",
		});
	}
}

let scrollTimeout: ReturnType<typeof setTimeout> | null = null;

function handleScroll() {
	if (scrollTimeout) clearTimeout(scrollTimeout);
	scrollTimeout = setTimeout(syncActiveTab, 50);
}

function syncActiveTab() {
	const track = trackRef.value;
	if (!track) return;

	const scrollLeft = track.scrollLeft;
	const cardWidth = track.offsetWidth;

	const index = Math.round(scrollLeft / cardWidth);
	if (index >= 0 && index < tabs.length) {
		activeIndex.value = index;
	}
}

onMounted(() => {
	syncActiveTab();
});

onBeforeUnmount(() => {
	if (scrollTimeout) clearTimeout(scrollTimeout);
});
</script>

<style scoped>
/* ===== Mobile: carousel mode (default) ===== */
.dashboard-carousel {
	display: flex;
	flex-direction: column;
	/* 100dvh minus nav (~52px) and main py-2 (8px top) */
	height: calc(100dvh - 52px - 0.5rem);
	overflow: hidden;
}

.carousel-tabs {
	display: flex;
	justify-content: space-around;
	align-items: center;
	padding: 0.5rem 0;
	border-bottom: 1px solid var(--color-gray-200, #e5e7eb);
	background: white;
	flex-shrink: 0;
}

.carousel-tab {
	display: flex;
	align-items: center;
	justify-content: center;
	padding: 0.5rem;
	border-radius: 0.5rem;
	color: var(--color-gray-400, #9ca3af);
	transition: color 0.15s, background-color 0.15s;
	position: relative;
	cursor: pointer;
	border: none;
	background: none;
}

.carousel-tab:hover {
	color: var(--color-gray-600, #4b5563);
	background-color: var(--color-gray-100, #f3f4f6);
}

.carousel-tab--active {
	color: var(--color-primary, #2563eb);
}

.carousel-tab--active::after {
	content: "";
	position: absolute;
	bottom: -0.5rem;
	left: 25%;
	right: 25%;
	height: 2px;
	background: var(--color-primary, #2563eb);
	border-radius: 1px;
}

.carousel-track {
	display: flex;
	overflow-x: auto;
	scroll-snap-type: x mandatory;
	-webkit-overflow-scrolling: touch;
	flex: 1;
	min-height: 0;
	scrollbar-width: none;
	-ms-overflow-style: none;
}

.carousel-track::-webkit-scrollbar {
	display: none;
}

.carousel-card {
	flex: 0 0 100%;
	min-width: 100%;
	scroll-snap-align: start;
	padding: 1rem;
}

.carousel-card-inner {
	height: 100%;
	overflow-y: auto;
	-webkit-overflow-scrolling: touch;
}

/* ===== Desktop: stacked mode (>=768px) ===== */
@media (min-width: 768px) {
	.dashboard-carousel {
		display: block;
		height: auto;
		overflow: visible;
	}

	.carousel-tabs {
		display: none;
	}

	.carousel-track {
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
		overflow-x: visible;
		scroll-snap-type: none;
	}

	.carousel-card {
		flex: 0 0 auto;
		min-width: 0;
		scroll-snap-align: none;
		padding: 0;
	}

	.carousel-card-inner {
		height: auto;
		overflow-y: visible;
	}
}
</style>
