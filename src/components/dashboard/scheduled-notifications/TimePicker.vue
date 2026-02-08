<template>
	<div class="w-full sm:max-w-xs">
		<Teleport to="body">
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
			v-if="isMounted"
			ref="datepicker"
			v-model="selectedTime"
			time-picker
			:time-config="timeConfig"
			:config="datepickerConfig"
			:min-time="minTime"
			:max-time="maxTime"
			:minutes-grid-increment="minutesIncrement"
			:disabled="isDisabled"
			:format="displayFormat"
			:input-attrs="inputAttributes"
			@open="handleMenuOpen"
			@closed="handleMenuClosed"
		/>
	</div>
</template>

<script lang="ts" setup>
import "@vuepic/vue-datepicker/dist/main.css";
import { VueDatePicker } from "@vuepic/vue-datepicker";
import { computed, onMounted, ref, watch } from "vue";
import {
	formatTimeValue,
	parseTimeString,
	resolveIs24,
} from "../../../lib/time/format";

type TimeModel = {
	hours: number | string;
	minutes: number | string;
	seconds?: number | string;
};

const props = defineProps<{
	inputId: string;
	inputName: string;
	initialTime: string | null;
	disabled?: boolean;
	inputAriaLabel?: string;
}>();

const emit = defineEmits<(event: "time-change", value: string) => void>();

const minutesIncrement = 1;
const minTime: TimeModel = { hours: 0, minutes: 0, seconds: 0 };
const maxTime: TimeModel = { hours: 23, minutes: 59, seconds: 0 };
const isMounted = ref(false);
const lastSyncedValue = ref<string | null>(null);
const selectedTime = ref<TimeModel | null>(
	parseTimeString(props.initialTime) ?? null,
);
const isDisabled = computed(() => props.disabled ?? false);
const is24 = ref(true);
const datepicker = ref<{ closeMenu: () => void } | null>(null);
const isBackdropVisible = ref(false);
const isBackdropPointerDown = ref(false);

/* ============= Menu Close Selection ============= */
const datepickerConfig = { setDateOnMenuClose: true } as const;

const displayFormat = computed(() => {
	return is24.value ? "HH:mm" : "hh:mm aa";
});

const timeConfig = computed(() => {
	return {
		is24: is24.value,
		minutesIncrement,
		startTime: { hours: 9, minutes: 0, seconds: 0 },
	};
});

function handleMenuOpen() {
	isBackdropPointerDown.value = false;
	isBackdropVisible.value = true;
}

function handleMenuClosed() {
	if (!isBackdropPointerDown.value) {
		isBackdropVisible.value = false;
	}
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
	return {
		id: props.inputId,
		class:
			"input cursor-pointer",
		"aria-label": props.inputAriaLabel,
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
		if (!isMounted.value) {
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
	() => props.initialTime,
	(value) => {
		const parsed = parseTimeString(value);
		selectedTime.value = parsed ?? null;
		lastSyncedValue.value = parsed ? formatTimeValue(parsed) : "";
	},
);

onMounted(() => {
	isMounted.value = true;
	is24.value = resolveIs24();
});
</script>

<style>
.sta-timepicker-backdrop {
	z-index: 10000;
}.dp__outer_menu_wrap,
.dp__menu {
	z-index: 10001;
}
</style>