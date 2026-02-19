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
			@click="handleTrackClick"
			@touchstart="handleTouchStart"
			@touchmove="handleTouchMove"
			@touchend="handleTouchEnd"
			@touchcancel="handleTouchCancel"
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
import ChartBarIcon from "../../icons/chart-bar.svg?component";
import NewspaperIcon from "../../icons/newspaper.svg?component";
import PresentationChartLineIcon from "../../icons/presentation-chart-line.svg?component";
import { getScrollBehavior } from "../../lib/accessibility";
import {
	DASHBOARD_SECTION_IDS,
} from "../../lib/constants";

interface Tab {
	id: string;
	label: string;
	icon: Component;
}

const tabs: Tab[] = [
	{ id: "setup", label: "Watchlist & Channels", icon: PresentationChartLineIcon },
	{ id: "schedule", label: "Alerts", icon: BellAlertIcon },
	{ id: "daily", label: "Daily", icon: NewspaperIcon },
	{ id: "market-notifications", label: "Market Notifications", icon: ChartBarIcon },
	{ id: "asset-events", label: "Asset Events", icon: CalendarDaysIcon },
];

/** Map hash fragment (without #) to tab index for hash-link sync. */
const HASH_TO_TAB_INDEX: Record<string, number> = {
	[DASHBOARD_SECTION_IDS.assets]: 0,
	[DASHBOARD_SECTION_IDS.notificationChannels]: 1,
	[DASHBOARD_SECTION_IDS.dailyNotifications]: 2,
	[DASHBOARD_SECTION_IDS.marketNotifications]: 3,
	[DASHBOARD_SECTION_IDS.assetEvents]: 4,
	// daily_digest_time input lives in schedule (Alerts) card
	daily_digest_time: 1,
};

const activeIndex = defineModel<number>('activeIndex', { default: 0 });
const trackRef = ref<HTMLElement | null>(null);
const cardRefs = ref<(HTMLElement | null)[]>([]);
let isMobileQuery: MediaQueryList | null = null;

// --- Touch tracking ---
let touchStartX: number | null = null;
let touchStartY: number | null = null;
/** Once we know the gesture direction we lock to horizontal or vertical for
 *  the remainder of the touch. null = undecided. */
let touchAxis: "horizontal" | "vertical" | null = null;

const SWIPE_THRESHOLD_PX = 30;
/** Minimum horizontal movement before we lock the axis (prevents jitter). */
const AXIS_LOCK_PX = 10;

function setCardRef(el: HTMLElement | null, index: number) {
	cardRefs.value[index] = el;
}

function scrollToCard(index: number) {
	const track = trackRef.value;
	const card = cardRefs.value[index];
	if (!card || !track) return;

	activeIndex.value = index;
	track.scrollTo({
		left: card.offsetLeft,
		behavior: getScrollBehavior(),
	});
}

/**
 * Returns true when the touch originated inside a nested element that is
 * intentionally horizontally scrollable (e.g. the Daily Digest preview
 * carousel). Such elements opt in with `data-horizontal-scroll`.
 *
 * We can't simply check `getComputedStyle(el).overflowX` because the CSS
 * spec forces `overflow-x` to `auto` whenever `overflow-y` is non-visible,
 * which would false-positive on every vertically-scrollable container
 * (like `.carousel-card-inner`).
 */
function isNestedHorizontalScroll(target: EventTarget | null): boolean {
	let el = target as HTMLElement | null;
	const track = trackRef.value;
	while (el && el !== track) {
		if (el.hasAttribute("data-horizontal-scroll")) {
			return true;
		}
		el = el.parentElement;
	}
	return false;
}

function resetTouch() {
	touchStartX = null;
	touchStartY = null;
	touchAxis = null;
}

function handleTouchStart(event: TouchEvent) {
	const touch = event.touches[0];
	if (!touch) return;

	// If the touch is inside a nested horizontal scroller, bail out so
	// the inner element (e.g. SMS ↔ Email preview carousel) scrolls instead.
	if (isNestedHorizontalScroll(event.target)) {
		resetTouch();
		return;
	}

	touchStartX = touch.clientX;
	touchStartY = touch.clientY;
	touchAxis = null;
}

function handleTouchMove(event: TouchEvent) {
	if (touchStartX == null || touchStartY == null) return;

	const touch = event.touches[0];
	if (!touch) return;

	const deltaX = Math.abs(touch.clientX - touchStartX);
	const deltaY = Math.abs(touch.clientY - touchStartY);

	// Lock the axis once the finger has moved enough to determine intent.
	if (touchAxis == null && (deltaX >= AXIS_LOCK_PX || deltaY >= AXIS_LOCK_PX)) {
		touchAxis = deltaX >= deltaY ? "horizontal" : "vertical";
	}

	// Once locked to horizontal, prevent the native scroll so the track
	// doesn't move at all — only our programmatic scrollToCard will move it.
	if (touchAxis === "horizontal") {
		event.preventDefault();
	}
}

function handleTouchEnd(event: TouchEvent) {
	if (touchStartX == null || touchStartY == null) {
		resetTouch();
		return;
	}

	const touch = event.changedTouches[0];
	if (!touch) {
		resetTouch();
		return;
	}

	const deltaX = touch.clientX - touchStartX;
	const axis = touchAxis;
	resetTouch();

	// Only act on horizontal swipes that exceeded the threshold.
	if (axis !== "horizontal") return;
	if (Math.abs(deltaX) < SWIPE_THRESHOLD_PX) return;

	const direction = deltaX < 0 ? 1 : -1;
	const nextIndex = Math.min(
		Math.max(activeIndex.value + direction, 0),
		tabs.length - 1,
	);

	scrollToCard(nextIndex);
}

function handleTouchCancel() {
	resetTouch();
}

let activeHashObserver: MutationObserver | null = null;
let activeHashTimeout: ReturnType<typeof setTimeout> | null = null;

/**
 * After switching cards on mobile, scroll the hash-target element into view
 * within the card's inner scroller. The target panel may be lazy-loaded (async
 * component), so the element might not exist yet — we observe the card subtree
 * for up to 2 s until it appears.
 */
function scrollToHashTarget(hash: string, cardIndex: number) {
	const card = cardRefs.value[cardIndex];
	const scroller = card?.querySelector<HTMLElement>(".carousel-card-inner");
	if (!scroller) return;

	// Clean up any previous observer
	if (activeHashObserver) {
		activeHashObserver.disconnect();
		activeHashObserver = null;
	}
	if (activeHashTimeout) {
		clearTimeout(activeHashTimeout);
		activeHashTimeout = null;
	}

	const doScroll = (el: HTMLElement) => {
		const scrollerRect = scroller.getBoundingClientRect();
		const elRect = el.getBoundingClientRect();
		const offset = elRect.top - scrollerRect.top + scroller.scrollTop;
		scroller.scrollTo({
			top: Math.max(0, offset - scroller.clientHeight / 2 + elRect.height / 2),
			behavior: getScrollBehavior(),
		});
	};

	const existing = document.getElementById(hash);
	if (existing) {
		// Element already in the DOM — wait for the card-switch scroll to land.
		const track = trackRef.value;
		if (!track) { doScroll(existing); return; }
		let scrolled = false;
		const scrollOnce = () => { if (!scrolled) { scrolled = true; doScroll(existing); } };
		const timer = setTimeout(scrollOnce, 400);
		track.addEventListener("scrollend", () => { clearTimeout(timer); scrollOnce(); }, { once: true });
		return;
	}

	// Element not yet mounted (lazy panel). Watch the card subtree for it.
	activeHashObserver = new MutationObserver(() => {
		const el = document.getElementById(hash);
		if (!el) return;
		activeHashObserver?.disconnect();
		activeHashObserver = null;
		if (activeHashTimeout) clearTimeout(activeHashTimeout);
		activeHashTimeout = null;
		requestAnimationFrame(() => doScroll(el));
	});
	activeHashObserver.observe(card, { childList: true, subtree: true });
	activeHashTimeout = setTimeout(() => {
		activeHashObserver?.disconnect();
		activeHashObserver = null;
		activeHashTimeout = null;
	}, 2000);
}

function handleTrackClick(event: MouseEvent) {
	const target = event.target as HTMLElement | null;
	const anchor = target?.closest("a[href]") as HTMLAnchorElement | null;
	if (!anchor) return;

	const href = anchor.getAttribute("href");
	if (!href?.startsWith("#")) return;

	// On desktop, preserve native in-page hash navigation between stacked panels.
	if (!isMobileQuery?.matches) return;

	const hash = href.slice(1);
	const index = HASH_TO_TAB_INDEX[hash];
	if (index === undefined) return;

	event.preventDefault();
	if (index !== activeIndex.value) {
		scrollToCard(index);
	}
	if (window.location.hash.slice(1) !== hash) {
		window.history.pushState(null, "", `#${hash}`);
	}

	scrollToHashTarget(hash, index);
}

/** Sync tab highlight and scroll position when user navigates via hash link. */
function syncToHash() {
	const hash = window.location.hash.slice(1);
	if (!hash) return;
	const index = HASH_TO_TAB_INDEX[hash];
	if (index === undefined || index === activeIndex.value) return;
	scrollToCard(index);
}

onMounted(() => {
	isMobileQuery = window.matchMedia("(max-width: 767.99px)");
	// Sync tab highlight when user follows hash links (e.g. Daily Digest link from Alerts tab)
	syncToHash();
	window.addEventListener("hashchange", syncToHash);
});

onUnmounted(() => {
	window.removeEventListener("hashchange", syncToHash);
	if (activeHashObserver) {
		activeHashObserver.disconnect();
		activeHashObserver = null;
	}
	if (activeHashTimeout) {
		clearTimeout(activeHashTimeout);
		activeHashTimeout = null;
	}
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
	/* No overflow-x: auto — JS controls all horizontal movement so native
	   momentum / scroll-snap can never fling through multiple cards. */
	overflow-x: hidden;
	flex: 1;
	min-height: 0;
}

.carousel-card {
	flex: 0 0 100%;
	min-width: 100%;
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
	}

	.carousel-card {
		flex: 0 0 auto;
		min-width: 0;
		padding: 0;
	}

	.carousel-card-inner {
		height: auto;
		overflow-y: visible;
	}
}
</style>
