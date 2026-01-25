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
			:disabled="isDisabled"
			:format="displayFormat"
			:input-attrs="inputAttributes"
		/>
	</div>
</template>

<script lang="ts" setup>
import "@vuepic/vue-datepicker/dist/main.css";
import { VueDatePicker } from "@vuepic/vue-datepicker";
import { computed, onMounted, ref, watch } from "vue";

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

const emit = defineEmits<{
	(event: "time-change", value: string): void;
}>();

const minutesIncrement = 15;
const minTime: TimeModel = { hours: 0, minutes: 0, seconds: 0 };
const maxTime: TimeModel = { hours: 23, minutes: 45, seconds: 0 };
const defaultTime: TimeModel = { hours: 9, minutes: 0, seconds: 0 };

const isMounted = ref(false);
const lastSyncedValue = ref<string | null>(null);
const selectedTime = ref<TimeModel>(parseTimeString(props.initialTime) ?? defaultTime);
const isDisabled = computed(() => props.disabled ?? false);
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
		// vue-datepicker v12 clear button is controlled by inputAttrs, not a top-level prop.
		clearable: false,
		alwaysClearable: false,
	};
});

const hiddenInputId = computed(() => {
	return `${props.inputId}-value`;
});

const formattedTime = computed(() => {
	const parsedHours =
		typeof selectedTime.value.hours === "string"
			? Number.parseInt(selectedTime.value.hours, 10)
			: selectedTime.value.hours;
	const parsedMinutes =
		typeof selectedTime.value.minutes === "string"
			? Number.parseInt(selectedTime.value.minutes, 10)
			: selectedTime.value.minutes;

	const hours = parsedHours;
	const minutes = parsedMinutes;

	return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
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
		const resolved = parsed ?? defaultTime;
		selectedTime.value = resolved;
		lastSyncedValue.value = formatTimeValue(resolved);
	},
);


function parseTimeString(value: string | null | undefined): TimeModel | null {
	if (!value) {
		return null;
	}

	const trimmed = value.trim();
	if (!trimmed) {
		return null;
	}

	const parts = trimmed.split(":");
	if (parts.length !== 2) {
		return null;
	}

	const [hoursPart, minutesPart] = parts;
	if (!hoursPart || !minutesPart) {
		return null;
	}

	if (!/^\d+$/.test(hoursPart) || !/^\d+$/.test(minutesPart)) {
		return null;
	}

	const hours = Number.parseInt(hoursPart, 10);
	const minutes = Number.parseInt(minutesPart, 10);

	if (
		!Number.isInteger(hours) ||
		!Number.isInteger(minutes) ||
		hours < 0 ||
		hours > 23 ||
		minutes < 0 ||
		minutes > 59
	) {
		return null;
	}
	return { hours, minutes, seconds: 0 };
}

function formatTimeValue(value: TimeModel): string {
	const hours =
		typeof value.hours === "string"
			? Number.parseInt(value.hours, 10)
			: value.hours;
	const minutes =
		typeof value.minutes === "string"
			? Number.parseInt(value.minutes, 10)
			: value.minutes;
	return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function resolveIs24(): boolean {
	const formatter = new Intl.DateTimeFormat(undefined, { hour: "numeric" });
	const options = formatter.resolvedOptions();
	return options.hourCycle === "h23" || options.hourCycle === "h24";
}

onMounted(() => {
	isMounted.value = true;
	is24.value = resolveIs24();
});
</script>

