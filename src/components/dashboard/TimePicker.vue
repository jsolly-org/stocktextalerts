<template>
	<div class="w-full max-w-xs">
		<input
			type="hidden"
			:id="hiddenInputId"
			:name="inputName"
			:value="formattedTime"
			:disabled="isDisabled"
		/>
		<VueDatePicker
			v-if="isMounted"
			v-model="selectedTime"
			time-picker
			:time-config="timeConfig"
			:min-time="minTime"
			:max-time="maxTime"
			:minutes-grid-increment="minutesIncrement"
			:clearable="false"
			:disabled="isDisabled"
			:format="displayFormat"
			:input-attrs="inputAttributes"
		/>
	</div>
</template>

<script lang="ts" setup>
import "@vuepic/vue-datepicker/dist/main.css";
import { VueDatePicker } from "@vuepic/vue-datepicker";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

type TimeModel = {
	hours: number | string;
	minutes: number | string;
	seconds?: number | string;
};

const props = defineProps<{
	inputId: string;
	inputName: string;
	initialTime: string;
	disabled?: boolean;
}>();

const minutesIncrement = 15;
const minTime: TimeModel = { hours: 0, minutes: 0, seconds: 0 };
const maxTime: TimeModel = { hours: 23, minutes: 45, seconds: 0 };
const defaultTime: TimeModel = { hours: 9, minutes: 0, seconds: 0 };

const isMounted = ref(false);
const selectedTime = ref<TimeModel>(parseTimeString(props.initialTime) ?? defaultTime);
const isDisabled = ref(props.disabled ?? false);
const is24 = ref(true);

const displayFormat = computed(() => {
	return is24.value ? "HH:mm" : "hh:mm aa";
});

const timeConfig = computed(() => {
	return {
		is24: is24.value,
		minutesIncrement,
	};
});

const inputAttributes = computed(() => {
	return {
		id: props.inputId,
		class:
			"w-full px-4 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 cursor-pointer disabled:bg-gray-100 disabled:cursor-not-allowed",
	};
});

const hiddenInputId = computed(() => {
	return `${props.inputId}-value`;
});

const formattedTime = computed(() => {
	if (!selectedTime.value) {
		return "";
	}

	const parsedHours =
		typeof selectedTime.value.hours === "string"
			? Number.parseInt(selectedTime.value.hours, 10)
			: selectedTime.value.hours;
	const parsedMinutes =
		typeof selectedTime.value.minutes === "string"
			? Number.parseInt(selectedTime.value.minutes, 10)
			: selectedTime.value.minutes;

	const hours = Number.isNaN(parsedHours) ? 0 : parsedHours;
	const minutes = Number.isNaN(parsedMinutes) ? 0 : parsedMinutes;

	return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
});

watch(
	() => props.disabled,
	(value) => {
		if (typeof value === "boolean") {
			isDisabled.value = value;
		}
	},
);

watch(
	() => props.initialTime,
	(value) => {
		const parsed = parseTimeString(value);
		selectedTime.value = parsed ?? defaultTime;
	},
);

function parseTimeString(value: string | null | undefined): TimeModel | null {
	if (!value) {
		return null;
	}

	const [hoursPart, minutesPart] = value.split(":");
	const hours = Number.parseInt(hoursPart ?? "", 10);
	const minutes = Number.parseInt(minutesPart ?? "", 10);

	if (Number.isNaN(hours) || Number.isNaN(minutes)) {
		return null;
	}
	return { hours, minutes, seconds: 0 };
}

function resolveIs24(): boolean {
	const resolved = new Intl.DateTimeFormat(undefined, {
		hour: "numeric",
	}).resolvedOptions();

	if (resolved.hourCycle) {
		return resolved.hourCycle === "h23" || resolved.hourCycle === "h24";
	}

	if (typeof resolved.hour12 === "boolean") {
		return !resolved.hour12;
	}

	return true;
}

function handleDailyDigestToggle(event: Event) {
	if (!(event instanceof CustomEvent)) {
		return;
	}

	const detail = event.detail as { enabled?: boolean } | null;
	if (!detail) {
		return;
	}

	if (typeof detail.enabled === "boolean") {
		isDisabled.value = !detail.enabled;
	}
}

onMounted(() => {
	isMounted.value = true;
	is24.value = resolveIs24();
	document.addEventListener("daily-digest-enabled-changed", handleDailyDigestToggle);
});

onBeforeUnmount(() => {
	document.removeEventListener(
		"daily-digest-enabled-changed",
		handleDailyDigestToggle,
	);
});
</script>

