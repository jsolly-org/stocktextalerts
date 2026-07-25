<template>
	<div class="relative w-full sm:max-w-xs">
		<Teleport v-if="isHydrated" to="body">
			<Transition
				enter-active-class="transition-[opacity,backdrop-filter] duration-150 ease-out"
				enter-from-class="opacity-0"
				enter-to-class="opacity-100"
				leave-active-class="transition-[opacity,backdrop-filter] duration-150 ease-in"
				leave-from-class="opacity-100"
				leave-to-class="opacity-0"
			>
				<div
					v-if="isBackdropVisible"
					class="sta-timepicker-backdrop fixed inset-0 bg-heading/25 backdrop-blur-sm backdrop-saturate-150"
					aria-hidden="true"
					@pointerdown="handleBackdropPointerDown"
					@pointerup="handleBackdropPointerUp"
					@pointercancel="handleBackdropPointerCancel"
				/>
			</Transition>
		</Teleport>
		<input
			type="hidden"
			:name="inputName"
			:value="formattedTime"
			:disabled="isDisabled"
		/>
		<VueDatePicker
			v-if="isHydrated"
			ref="datepicker"
			v-model="selectedTime"
			time-picker
			centered
			:placeholder="props.placeholder"
			:time-config="timeConfig"
			:config="datepickerConfig"
			:formats="formats"
			:floating="floatingConfig"
			:min-time="minTime"
			:max-time="maxTime"
			:disabled-times="disabledTimes"
			:disabled="isDisabled"
			:input-attrs="inputAttributes"
			@open="handleMenuOpen"
			@closed="handleMenuClosed"
		/>
		<!-- Overlay icons inside the right edge of the input -->
		<div
			v-if="clearable || hasTrailingContent"
			class="absolute inset-y-0 right-0 flex items-center gap-1.5 pr-2 pointer-events-none"
		>
			<span v-if="hasTrailingContent" class="pointer-events-auto">
				<slot name="trailing" />
			</span>
			<button
				v-if="clearable"
				type="button"
				class="pointer-events-auto btn-icon-danger p-1.5"
				:aria-label="clearAriaLabel ?? 'Clear time'"
				@click.stop="emit('clear')"
			>
				<XMarkIcon class="size-3.5" aria-hidden="true" />
			</button>
		</div>
	</div>
</template>

<script lang="ts" setup>
import "@vuepic/vue-datepicker/dist/main.css";
import { VueDatePicker } from "@vuepic/vue-datepicker";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

import XMarkIcon from "../../../icons/x-mark.svg?component";
import {
	formatTimeValue,
	resolveIs24,
} from "../../../lib/time/display";
import { parseTimeString } from "../../../lib/time/parse";
import { useHydrated } from "../../useHydrated";

type TimeModel = {
	hours: number | string;
	minutes: number | string;
	seconds?: number | string;
};

const props = withDefaults(
	defineProps<{
		inputId: string;
		inputName: string;
		initialTime: string | null;
		disabled?: boolean;
		inputAriaLabel?: string;
		/** Placeholder when no time selected */
		placeholder?: string;
		/** Show X clear button inside the input */
		clearable?: boolean;
		/** Accessible label for the clear button */
		clearAriaLabel?: string;
		/** Force 24-hour / 12-hour display. Falls back to locale detection when omitted. */
		is24?: boolean;
		/**
		 * Minimum selectable time (hours/minutes). Defaults to 00:00.
		 * Same-day window only: @vuepic/vue-datepicker does not support cross-midnight ranges.
		 * minTimeOverride must be <= maxTimeOverride; otherwise behavior is undefined.
		 */
		minTimeOverride?: { hours: number; minutes: number };
		/**
		 * Maximum selectable time (hours/minutes). Defaults to 23:59.
		 * Same-day window only: must be >= minTimeOverride (no overnight ranges).
		 */
		maxTimeOverride?: { hours: number; minutes: number };
		/** Tooltip text shown when hovering a time outside the allowed range. */
		disabledRangeTooltip?: string;
		/** ID of an element describing the input (for `aria-describedby`, e.g. a constraint hint). */
		inputAriaDescribedby?: string;
		/** Reserve right-edge padding for the `#trailing` slot when it will render visible content. */
		hasTrailingContent?: boolean;
	}>(),
	{ placeholder: "Select time" },
);

const emit = defineEmits<{
	(event: "time-change", value: string): void;
	(event: "clear"): void;
}>();

const PADDING_ONE_ICON = "!pr-9";
// Reserve enough right-edge room for the session badge ("pre-market 🌅" /
// "after-hours 🌙") plus the clear button so neither overlaps the time text.
// The badge + X button run ~150px wide; pr-44 (176px) keeps a comfortable gap
// while still leaving room for the time value on a narrow mobile input.
const PADDING_BADGE_AND_ICON = "!pr-44";

const minutesIncrement = 1;

function minutesSinceMidnight(t: { hours: number; minutes: number }): number {
	return t.hours * 60 + t.minutes;
}

const hasInvalidOverrideRange = computed(() => {
	if (!props.minTimeOverride || !props.maxTimeOverride) return false;
	return (
		minutesSinceMidnight(props.minTimeOverride) >
		minutesSinceMidnight(props.maxTimeOverride)
	);
});

const minTime = computed<TimeModel>(() => {
	// Parent must pass min <= max (same-day window only); vue-datepicker does not support cross-midnight.
	if (hasInvalidOverrideRange.value) {
		return { hours: 0, minutes: 0, seconds: 0 };
	}
	return props.minTimeOverride
		? {
				hours: props.minTimeOverride.hours,
				minutes: props.minTimeOverride.minutes,
				seconds: 0,
			}
		: { hours: 0, minutes: 0, seconds: 0 };
});
const maxTime = computed<TimeModel>(() => {
	if (hasInvalidOverrideRange.value) {
		return { hours: 23, minutes: 59, seconds: 0 };
	}
	return props.maxTimeOverride
		? {
				hours: props.maxTimeOverride.hours,
				minutes: props.maxTimeOverride.minutes,
				seconds: 0,
			}
		: { hours: 23, minutes: 59, seconds: 0 };
});

// Disables hours/minutes outside the override range in the overlay grid and
// on the inc/dec steppers. When no range is set (or the range is invalid),
// every time is allowed.
const disabledTimes = computed<
	((time: { hours: number; minutes: number; seconds: number }) => boolean) | undefined
>(() => {
	if (!props.minTimeOverride || !props.maxTimeOverride) return undefined;
	if (hasInvalidOverrideRange.value) return undefined;
	const minMinutes = minutesSinceMidnight(props.minTimeOverride);
	const maxMinutes = minutesSinceMidnight(props.maxTimeOverride);
	return (time) => {
		const total = time.hours * 60 + time.minutes;
		return total < minMinutes || total > maxMinutes;
	};
});
const isHydrated = useHydrated();
const lastSyncedValue = ref<string | null>(null);
const selectedTime = ref<TimeModel | null>(
	parseTimeString(props.initialTime) ?? null,
);
const isDisabled = computed(() => props.disabled ?? false);
const is24Hour = ref(true);
const datepicker = ref<{ closeMenu: () => void } | null>(null);
const isBackdropVisible = ref(false);
const isBackdropPointerDown = ref(false);

/* ============= Menu Close Selection ============= */
// centered alone (do not pair with teleport — docs warn that combination can
// mis-position). mobileBreakpoint matches Tailwind `sm` so our full-viewport
// takeover tracks the same width as the rest of the dashboard.
const datepickerConfig = {
	setDateOnMenuClose: true,
	mobileBreakpoint: 640,
} as const;

// centered already suppresses the floating arrow in the library; keep arrow
// off explicitly so a future teleport/layout change cannot bring it back.
const floatingConfig = { arrow: false } as const;

const formats = computed(() => ({
	input: is24Hour.value ? "HH:mm" : "hh:mm aa",
}));

const timeConfig = computed(() => {
	return {
		is24: is24Hour.value,
		minutesIncrement,
		minutesGridIncrement: minutesIncrement,
		startTime: { hours: 9, minutes: 0, seconds: 0 },
	};
});

const DISABLED_SELECTORS =
	".dp--overlay-cell-disabled, .dp--overlay-cell-active-disabled, .dp--inc-dec-button-disabled";
let disabledTooltipObserver: MutationObserver | null = null;

function applyDisabledTooltips(root: ParentNode) {
	const tooltip = props.disabledRangeTooltip;
	if (!tooltip) return;
	const nodes = root.querySelectorAll(DISABLED_SELECTORS);
	for (const node of nodes) {
		if (!(node instanceof HTMLElement)) continue;
		if (node.getAttribute("title") !== tooltip) {
			node.setAttribute("title", tooltip);
		}
		node.setAttribute("aria-disabled", "true");
		if (node.getAttribute("aria-label") !== tooltip) {
			node.setAttribute("aria-label", tooltip);
		}
	}
}

function dismissBackdrop() {
	isBackdropPointerDown.value = false;
	isBackdropVisible.value = false;
}

// Drive body scroll from scrim visibility so open/close paths cannot diverge.
watch(isBackdropVisible, (visible) => {
	document.body.style.overflow = visible ? "hidden" : "";
});

function handleMenuOpen() {
	isBackdropPointerDown.value = false;
	isBackdropVisible.value = true;
	if (!props.disabledRangeTooltip) return;
	// Overlay grid cells mount after open (and again when toggling hours/
	// minutes). Observe the document so tooltips apply whenever they appear.
	// Menu stays in-tree under `centered` (no teleport).
	disabledTooltipObserver?.disconnect();
	disabledTooltipObserver = new MutationObserver(() => {
		applyDisabledTooltips(document.body);
	});
	disabledTooltipObserver.observe(document.body, {
		childList: true,
		subtree: true,
	});
	applyDisabledTooltips(document.body);
}

function handleMenuClosed() {
	// Always clear scrim + scroll lock. Do not gate on pointerdown — that flag
	// exists only to suppress fallthrough clicks, and preventDefault on
	// pointerdown can cancel the click that used to clear it (leaving the page
	// frozen after ESC / Select).
	dismissBackdrop();
	disabledTooltipObserver?.disconnect();
	disabledTooltipObserver = null;
}

function handleBackdropPointerDown(event: PointerEvent) {
	if (event.button !== 0) return;
	isBackdropPointerDown.value = true;
	// Suppress the compatibility click that would otherwise land on content
	// beneath once the scrim unmounts mid-gesture. Dismiss on pointerup instead.
	event.preventDefault();
}

function handleBackdropPointerUp(event: PointerEvent) {
	if (!isBackdropPointerDown.value || event.button !== 0) return;
	// Ignore releases that started on the scrim but ended elsewhere.
	if (event.target !== event.currentTarget) {
		isBackdropPointerDown.value = false;
		return;
	}
	event.preventDefault();
	event.stopPropagation();
	dismissBackdrop();
	datepicker.value?.closeMenu();
}

function handleBackdropPointerCancel() {
	dismissBackdrop();
	datepicker.value?.closeMenu();
}

const inputAttributes = computed(() => {
	const paddingClass = props.hasTrailingContent
		? PADDING_BADGE_AND_ICON
		: props.clearable
			? PADDING_ONE_ICON
			: "";
	return {
		id: props.inputId,
		class: `input ${paddingClass}`.trim(),
		"aria-label": props.inputAriaLabel,
		...(props.inputAriaDescribedby
			? { "aria-describedby": props.inputAriaDescribedby }
			: {}),
		// vue-datepicker v12 clear button is controlled by inputAttrs, not a top-level prop.
		clearable: false,
		alwaysClearable: false,
	};
});

const formattedTime = computed(() => {
	if (!selectedTime.value) {
		return "";
	}
	return formatTimeValue(selectedTime.value);
});

watch(
	formattedTime,
	(newValue) => {
		if (!isHydrated.value) {
			return;
		}
		if (newValue === lastSyncedValue.value) {
			return;
		}
		emit("time-change", newValue);
		lastSyncedValue.value = newValue;
	},
	{ flush: "post" },
);

watch(
	() => props.is24,
	(value) => {
		is24Hour.value = value ?? resolveIs24();
	},
);

watch(
	() => props.initialTime,
	(value) => {
		const parsed = parseTimeString(value);
		selectedTime.value = parsed ?? null;
		lastSyncedValue.value = parsed ? formatTimeValue(parsed) : "";
	},
);

onMounted(() => {
	is24Hour.value = props.is24 ?? resolveIs24();
});

onBeforeUnmount(() => {
	// Disconnect any in-flight observer so it can't keep firing against
	// document.body after this component is gone — handleMenuClosed normally
	// handles this, but the picker can be removed mid-open (route change,
	// parent v-if).
	disabledTooltipObserver?.disconnect();
	disabledTooltipObserver = null;
	dismissBackdrop();
});
</script>

<style>
.sta-timepicker-backdrop {
	z-index: 10000;
}

.dp--outer-menu-wrap,
.dp--menu {
	z-index: 10001;
}

/*
 * Centered modal above the scrim.
 *
 * Docs: use `centered` (renamed from teleport-center); do not combine with
 * `teleport`. Library CSS sets `.dp--centered { position: fixed; … }`, but
 * without teleport it also applies `.dp--menu-wrapper { position: absolute }`,
 * which wins in source order and anchors to a parent instead of the viewport.
 * Reassert fixed centering here.
 */
.dp--menu-wrapper.dp--outer-menu-wrap.dp--centered {
	position: fixed;
	top: 50%;
	left: 50%;
	right: auto;
	bottom: auto;
	transform: translate(-50%, -50%);
	z-index: 10001;
}

.dp--outer-menu-wrap.dp--centered .dp--menu {
	border-radius: 0.75rem;
	min-width: min(20rem, calc(100vw - 2rem));
	box-shadow:
		0 10px 15px -3px rgb(0 0 0 / 0.12),
		0 20px 40px -12px rgb(0 0 0 / 0.2);
}

/*
 * Mobile full-viewport takeover. Hook the library's own mobile flag
 * (`data-dp-mobile`, set when clientWidth <= config.mobileBreakpoint) so this
 * tracks the same breakpoint as vue-datepicker's layout — not a separate
 * media-query width.
 */
[data-datepicker-instance][data-dp-mobile]
	.dp--menu-wrapper.dp--outer-menu-wrap.dp--centered {
	inset: 0;
	top: 0;
	left: 0;
	width: 100%;
	height: 100%;
	transform: none;
}

[data-datepicker-instance][data-dp-mobile]
	.dp--outer-menu-wrap.dp--centered
	.dp--menu {
	display: flex;
	flex-direction: column;
	justify-content: center;
	width: 100%;
	height: 100%;
	min-width: 0;
	min-height: 100%;
	border: none;
	border-radius: 0;
	box-shadow: none;
	padding-top: max(1.5rem, env(safe-area-inset-top, 0px));
	padding-right: max(1rem, env(safe-area-inset-right, 0px));
	padding-bottom: max(1.5rem, env(safe-area-inset-bottom, 0px));
	padding-left: max(1rem, env(safe-area-inset-left, 0px));
}

/* Prevent iOS double-tap zoom on repeated time-stepper taps. */
.dp--inc-dec-button,
.dp--button,
.dp--pm-am-button {
	touch-action: manipulation;
}

/*
 * Stronger disabled-state affordance for out-of-range cells. vue-datepicker
 * already applies cursor: not-allowed; we add fade + strike-through + a
 * muted background so the contrast is unmistakable against our theme
 * tokens (the default --dp-disabled-color is barely distinguishable).
 *
 * Selectors chain a second class to beat vue-datepicker's single-class
 * rules without resorting to !important. The matching :hover variant
 * pins the same look so the cell doesn't brighten on hover.
 */
.dp--overlay-cell-disabled.dp--overlay-cell-pad,
.dp--overlay-cell-active-disabled.dp--overlay-cell-pad {
	opacity: 0.4;
	background-color: var(--surface-alt);
	color: var(--muted);
	text-decoration: line-through;
}
.dp--overlay-cell-disabled.dp--overlay-cell-pad:hover,
.dp--overlay-cell-active-disabled.dp--overlay-cell-pad:hover {
	background-color: var(--surface-alt);
	color: var(--muted);
}

/*
 * Override VueDatePicker theme to use our design tokens.
 * The library always renders dp--theme-light; we remap its CSS
 * variables so both light and dark mode stay consistent with the
 * `.input` utility class used by the rest of the app.
 */
.dp--theme-light {
	--dp-background-color: var(--surface);
	--dp-text-color: var(--heading);
	--dp-border-color: var(--edge-strong);
	--dp-menu-border-color: var(--edge-strong);
	--dp-border-color-hover: var(--muted);
	--dp-border-color-focus: var(--color-primary);
	--dp-hover-color: var(--surface-active);
	--dp-hover-text-color: var(--heading);
	--dp-hover-icon-color: var(--muted);
	--dp-icon-color: var(--muted);
	--dp-disabled-color: var(--disabled-bg);
	--dp-disabled-color-text: var(--muted);
	--dp-primary-color: var(--color-primary);
	--dp-secondary-color: var(--body-secondary);
	--dp-scroll-bar-background: var(--surface-alt);
	--dp-scroll-bar-color: var(--muted);
}
</style>
