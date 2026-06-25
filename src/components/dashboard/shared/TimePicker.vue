<template>
	<div class="relative w-full sm:max-w-xs">
		<Teleport v-if="isHydrated" to="body">
			<div
				v-if="isBackdropVisible"
				class="sta-timepicker-backdrop fixed inset-0 bg-transparent"
				aria-hidden="true"
				@pointerdown="handleBackdropPointerDown"
				@click="handleBackdropClick"
				@pointercancel="handleBackdropPointerCancel"
			/>
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
			:placeholder="props.placeholder"
			:time-config="timeConfig"
			:config="datepickerConfig"
			:min-time="minTime"
			:max-time="maxTime"
			:disabled-times="disabledTimes"
			:minutes-grid-increment="minutesIncrement"
			:disabled="isDisabled"
			:format="displayFormat"
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
	parseTimeString,
	resolveIs24,
} from "../../../lib/time/format";
import { useHydrated } from "../../composables/useHydrated";

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
const PADDING_BADGE_AND_ICON = "!pr-36";

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
const datepickerConfig = { setDateOnMenuClose: true } as const;

const displayFormat = computed(() => {
	return is24Hour.value ? "HH:mm" : "hh:mm aa";
});

const timeConfig = computed(() => {
	return {
		is24: is24Hour.value,
		minutesIncrement,
		startTime: { hours: 9, minutes: 0, seconds: 0 },
	};
});

const DISABLED_SELECTORS =
	".dp__overlay_cell_disabled, .dp__overlay_cell_active_disabled, .dp__inc_dec_button_disabled";
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

function handleMenuOpen() {
	isBackdropPointerDown.value = false;
	isBackdropVisible.value = true;
	if (!props.disabledRangeTooltip) return;
	// vue-datepicker teleports the menu to <body>, and the overlay grid is
	// rendered after the initial open (toggling between hours/minutes). Observe
	// body mutations briefly so disabled cells get their tooltip no matter when
	// they appear.
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
	if (!isBackdropPointerDown.value) {
		isBackdropVisible.value = false;
	}
	disabledTooltipObserver?.disconnect();
	disabledTooltipObserver = null;
}

function handleBackdropPointerDown(event: PointerEvent) {
	isBackdropPointerDown.value = true;
	isBackdropVisible.value = true;

	// Prevent fallthrough clicks. Some browsers can retarget the click to the element
	// beneath if the picker closes before the click completes.
	event.preventDefault();
}

function handleBackdropClick(event: MouseEvent) {
	if (!isBackdropVisible.value) {
		return;
	}
	event.preventDefault();
	event.stopPropagation();

	isBackdropPointerDown.value = false;
	isBackdropVisible.value = false;

	datepicker.value?.closeMenu();
}

function handleBackdropPointerCancel() {
	isBackdropPointerDown.value = false;
	isBackdropVisible.value = false;
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
		class: `input cursor-pointer ${paddingClass}`.trim(),
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
});
</script>

<style>
.sta-timepicker-backdrop {
	z-index: 10000;
}

.dp__outer_menu_wrap,
.dp__menu {
	z-index: 10001;
}

/* Prevent iOS double-tap zoom on repeated time-stepper taps. */
.dp__inc_dec_button,
.dp__button,
.dp__pm_am_button {
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
.dp__overlay_cell_disabled.dp__overlay_cell_pad,
.dp__overlay_cell_active_disabled.dp__overlay_cell_pad {
	opacity: 0.4;
	background-color: var(--surface-alt);
	color: var(--muted);
	text-decoration: line-through;
}
.dp__overlay_cell_disabled.dp__overlay_cell_pad:hover,
.dp__overlay_cell_active_disabled.dp__overlay_cell_pad:hover {
	background-color: var(--surface-alt);
	color: var(--muted);
}

/*
 * Override VueDatePicker theme to use our design tokens.
 * The library always renders dp__theme_light; we remap its CSS
 * variables so both light and dark mode stay consistent with the
 * `.input` utility class used by the rest of the app.
 */
.dp__theme_light {
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
