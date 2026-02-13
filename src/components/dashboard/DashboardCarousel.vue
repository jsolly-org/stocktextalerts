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
			@touchstart.passive="handleTouchStart"
			@touchend.passive="handleTouchEnd"
			@touchcancel.passive="handleTouchCancel"
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
import { type Component, onMounted, onUnmounted, ref } from "vue";
import BellAlertIcon from "../../icons/bell-alert.svg?component";
import CalendarDaysIcon from "../../icons/calendar-days.svg?component";
import EyeIcon from "../../icons/eye.svg?component";
import NewspaperIcon from "../../icons/newspaper.svg?component";
import PresentationChartLineIcon from "../../icons/presentation-chart-line.svg?component";

interface Tab {
	id: string;
	label: string;
	icon: Component;
}

const tabs: Tab[] = [
	{ id: "setup", label: "Watchlist & Channels", icon: PresentationChartLineIcon },
	{ id: "daily", label: "Daily", icon: NewspaperIcon },
	{ id: "schedule", label: "Alerts", icon: BellAlertIcon },
	{ id: "asset-events", label: "Asset Events", icon: CalendarDaysIcon },
	{ id: "preview", label: "Preview", icon: EyeIcon },
];

const activeIndex = ref(0);
const trackRef = ref<HTMLElement | null>(null);
const cardRefs = ref<(HTMLElement | null)[]>([]);
const prefersReducedMotion = ref(false);
let motionQuery: MediaQueryList | null = null;
let touchStartX: number | null = null;
let touchStartY: number | null = null;
let pendingScrollTargetIndex: number | null = null;
let pendingScrollTargetLeft: number | null = null;
let pendingScrollClearTimeout: number | null = null;

const SWIPE_THRESHOLD_PX = 30;
const PROGRAMMATIC_SCROLL_TIMEOUT_MS = 700;
const PROGRAMMATIC_SCROLL_EPSILON_PX = 2;

function setCardRef(el: HTMLElement | null, index: number) {
	cardRefs.value[index] = el;
}

function clearPendingProgrammaticScroll() {
	pendingScrollTargetIndex = null;
	pendingScrollTargetLeft = null;
	if (pendingScrollClearTimeout != null) {
		window.clearTimeout(pendingScrollClearTimeout);
		pendingScrollClearTimeout = null;
	}
}

function scrollToCard(index: number) {
	const card = cardRefs.value[index];
	if (card && trackRef.value) {
		clearPendingProgrammaticScroll();
		pendingScrollTargetIndex = index;
		pendingScrollTargetLeft = card.offsetLeft;

		activeIndex.value = index;
		trackRef.value.scrollTo({
			left: card.offsetLeft,
			behavior: prefersReducedMotion.value ? "auto" : "smooth",
		});

		// If we didn't animate (or we're already there), don't block scroll syncing.
		if (
			prefersReducedMotion.value ||
			Math.abs(trackRef.value.scrollLeft - card.offsetLeft) <=
				PROGRAMMATIC_SCROLL_EPSILON_PX
		) {
			clearPendingProgrammaticScroll();
		} else {
			// Failsafe so we never get stuck ignoring scroll events.
			pendingScrollClearTimeout = window.setTimeout(() => {
				clearPendingProgrammaticScroll();
			}, PROGRAMMATIC_SCROLL_TIMEOUT_MS);
		}
	}
}

function handleScroll() {
	syncActiveTab();
}

function handleTouchStart(event: TouchEvent) {
	const touch = event.touches[0];
	if (!touch) return;
	touchStartX = touch.clientX;
	touchStartY = touch.clientY;
}

function handleTouchEnd(event: TouchEvent) {
	if (touchStartX == null || touchStartY == null) return;

	const touch = event.changedTouches[0];
	if (!touch) return;

	const deltaX = touch.clientX - touchStartX;
	const deltaY = touch.clientY - touchStartY;

	touchStartX = null;
	touchStartY = null;

	// Ignore mostly vertical gestures so panel scrolling stays natural.
	if (Math.abs(deltaY) >= Math.abs(deltaX)) return;
	if (Math.abs(deltaX) < SWIPE_THRESHOLD_PX) return;

	const direction = deltaX < 0 ? 1 : -1;
	const nextIndex = Math.min(
		Math.max(activeIndex.value + direction, 0),
		tabs.length - 1,
	);

	if (nextIndex !== activeIndex.value) {
		scrollToCard(nextIndex);
	}
}

function handleTouchCancel() {
	touchStartX = null;
	touchStartY = null;
}

function syncActiveTab() {
	const track = trackRef.value;
	if (!track) return;

	if (pendingScrollTargetIndex != null && pendingScrollTargetLeft != null) {
		if (
			Math.abs(track.scrollLeft - pendingScrollTargetLeft) >
			PROGRAMMATIC_SCROLL_EPSILON_PX
		) {
			return;
		}

		activeIndex.value = pendingScrollTargetIndex;
		clearPendingProgrammaticScroll();
		return;
	}

	const scrollLeft = track.scrollLeft;
	const cardWidth = track.offsetWidth;
	if (cardWidth === 0) return;

	const index = Math.round(scrollLeft / cardWidth);
	if (index >= 0 && index < tabs.length) {
		activeIndex.value = index;
	}
}

function handleMotionChange(event: MediaQueryListEvent) {
	prefersReducedMotion.value = event.matches;
}

onMounted(() => {
	syncActiveTab();
	motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
	prefersReducedMotion.value = motionQuery.matches;
	motionQuery.addEventListener("change", handleMotionChange);
});

onUnmounted(() => {
	motionQuery?.removeEventListener("change", handleMotionChange);
});
</script>

<style scoped>
/* ===== Mobile: carousel mode (default) ===== */
.dashboard-carousel {
	display: flex;
	flex-direction: column;
	height: calc(100vh - 52px - 0.5rem);
	overflow: hidden;
	overscroll-behavior: contain;
}

@supports (height: 100svh) {
	.dashboard-carousel {
		/* Keep mobile height stable while browser chrome expands/collapses. */
		height: calc(100svh - 52px - 0.5rem);
	}
}

.carousel-tabs {
	display: flex;
	justify-content: space-around;
	align-items: center;
	padding: 0.5rem 0;
	border-bottom: 1px solid var(--color-edge);
	background: var(--color-surface);
	flex-shrink: 0;
}

.carousel-tab {
	display: flex;
	align-items: center;
	justify-content: center;
	padding: 0.5rem;
	border-radius: 0.5rem;
	color: var(--color-faint);
	transition: color 0.15s, background-color 0.15s;
	position: relative;
	cursor: pointer;
	border: none;
	background: none;
}

.carousel-tab:hover {
	color: var(--color-body-secondary);
	background-color: var(--color-surface-active);
}

.carousel-tab:focus-visible {
	outline: 2px solid var(--color-primary, #2563eb);
	outline-offset: -2px;
	color: var(--color-label);
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
	touch-action: pan-y;
	flex: 1;
	min-height: 0;
	scrollbar-width: none;
	-ms-overflow-style: none;
	overscroll-behavior-x: contain;
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
