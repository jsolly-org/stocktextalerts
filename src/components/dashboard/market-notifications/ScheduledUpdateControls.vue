<template>
	<fieldset
		data-autosave-ignore
		:class="[
			'divide-y divide-divider transition-opacity duration-200',
			{ 'opacity-50': needsChannelSelection },
		]"
		:aria-disabled="needsChannelSelection ? 'true' : 'false'"
	>
		<legend class="sr-only">Scheduled update settings</legend>

		<div class="py-3">
			<fieldset class="grid gap-3">
				<legend class="block text-base font-semibold text-heading mb-1">
					Delivery times
					<span class="block text-sm font-normal text-body-secondary mt-0.5">Choose up to 5 time slots.</span>
				</legend>
				<input
					type="hidden"
					name="market_scheduled_asset_price_times"
					:value="serializedTimes"
				/>
			<div class="space-y-2">
				<!-- Empty picker shown when no times exist, so user can pick their first time -->
				<div v-if="scheduledUpdateTimes.length === 0" class="flex flex-wrap items-center gap-2">
					<TimePicker
						inputId="scheduled_update_time_initial"
						inputName="scheduled_update_time_initial"
						:initialTime="null"
						placeholder="Select notification time"
						inputAriaLabel="Pick a delivery time"
						:disabled="timePickerDisabled"
						:is24="is24"
						@time-change="emit('add-initial-time', $event)"
					/>
					<button
						v-if="marketOpenLabel"
						type="button"
						class="btn btn-sm btn-secondary self-start"
						:disabled="!canAddMarketOpen"
						:aria-label="`Set delivery time to US market open (${marketOpenLabel})`"
						@click="emit('add-market-open')"
					>
						<PresentationChartLineIcon class="size-4 shrink-0" aria-hidden="true" />
						Market open
					</button>
				</div>
			<div
				v-for="(time, index) in scheduledUpdateTimes"
				:key="`${index}-${time}`"
			>
				<TimePicker
					:inputId="`scheduled_update_time_${index}`"
					:inputName="`scheduled_update_time_${index}`"
					:initialTime="time"
					placeholder="Select notification time"
					:inputAriaLabel="`Delivery time ${index + 1}`"
					:disabled="timePickerDisabled"
					:outsideMarketHours="outsideMarketHoursIndices.has(index)"
					clearable
					:clearAriaLabel="`Remove delivery time ${index + 1}`"
					:is24="is24"
					@time-change="emit('time-change', index, $event)"
					@clear="emit('remove-time', index)"
				/>
			</div>
				</div>
			<div class="flex flex-col gap-2">
				<div class="flex flex-wrap gap-2">
					<button
						v-if="scheduledUpdateTimes.length > 0"
						type="button"
						class="btn btn-sm btn-secondary self-start"
						:disabled="!canAddTime"
						aria-label="Add time"
						@click="emit('add-time')"
					>
						<PlusIcon class="size-4 shrink-0" aria-hidden="true" />
					Add time
				</button>
				<button
					v-if="marketOpenLabel && scheduledUpdateTimes.length > 0"
					type="button"
					class="btn btn-sm btn-secondary self-start"
					:disabled="!canAddMarketOpen"
					:aria-label="`Set delivery time to US market open (${marketOpenLabel})`"
					@click="emit('add-market-open')"
				>
				<PresentationChartLineIcon class="size-4 shrink-0" aria-hidden="true" />
				Market open
				</button>
			</div>
				<StatusMessage v-if="maxTimesReached" tone="warning">
					You've reached the maximum of {{ maxTimes }} delivery times.
				</StatusMessage>
			</div>
			</fieldset>
		</div>
	</fieldset>

	<div v-if="!needsChannelSelection && isHydrated && countdownText" class="mt-4 border-t border-edge pt-4">
		<p class="inline-flex items-center gap-2 text-sm text-body-secondary">
			<BellAlertIcon class="size-4 shrink-0 text-success-strong" aria-hidden="true" />
			<span>Next delivery <span class="font-medium text-heading">{{ countdownText }}</span></span>
		</p>
		<p v-if="countdownDelayReasons.length > 0" class="mt-1 text-xs text-body-secondary">
			Delayed to the next slot because the market is closed for
			{{ delayReasonLabel }}.
		</p>
	</div>
</template>

<script lang="ts" setup>
import { computed, onMounted, ref } from "vue";

// ?component suffix required: Astro Icon cannot be used in Vue; vite-svg-loader compiles this to a Vue component.
import BellAlertIcon from "../../../icons/bell-alert.svg?component";
import PlusIcon from "../../../icons/plus.svg?component";
import PresentationChartLineIcon from "../../../icons/presentation-chart-line.svg?component";
import StatusMessage from "../../StatusMessage.vue";
import TimePicker from "../shared/TimePicker.vue";

interface Props {
	scheduledUpdateTimes: string[];
	needsChannelSelection: boolean;
	timePickerDisabled: boolean;
	canAddTime: boolean;
	canAddMarketOpen: boolean;
	marketOpenLabel: string | null;
	maxTimes: number;
	maxTimesReached: boolean;
	countdownText: string | null;
	countdownDelayReasons: Array<"weekend" | "holiday">;
	countdownHolidayName: string | null;
	outsideMarketHoursIndices: Set<number>;
	/** Force 24-hour / 12-hour display on time pickers. */
	is24?: boolean;
}

const props = defineProps<Props>();

const isHydrated = ref(false);

const emit = defineEmits<{
	(event: "time-change", index: number, value: string): void;
	(event: "add-time"): void;
	(event: "add-initial-time", value: string): void;
	(event: "add-market-open"): void;
	(event: "remove-time", index: number): void;
}>();

onMounted(() => {
	isHydrated.value = true;
});

const serializedTimes = computed(() => JSON.stringify(props.scheduledUpdateTimes));

const HOLIDAY_EMOJIS: Record<string, string> = {
	"New Year's Day": "\u{1F389}",        // 🎉
	"Martin Luther King Jr. Day": "\u{270A}\u{1F3FE}", // ✊🏾
	"Washington's Birthday": "\u{1F1FA}\u{1F1F8}", // 🇺🇸
	"Good Friday": "\u{1F54A}\u{FE0F}",   // 🕊️
	"Memorial Day": "\u{1FA96}",           // 🪖
	"Juneteenth National Independence Day": "\u{270A}\u{1F3FF}", // ✊🏿
	"Independence Day": "\u{1F386}",       // 🎆
	"Labor Day": "\u{1F477}",             // 👷
	"Thanksgiving": "\u{1F983}",           // 🦃
	"Christmas": "\u{1F384}",             // 🎄
};

const delayReasonLabel = computed(() => {
	const reasons = props.countdownDelayReasons;
	const hasWeekend = reasons.includes("weekend");
	const hasHoliday = reasons.includes("holiday");
	const name = props.countdownHolidayName;
	const emoji = name ? HOLIDAY_EMOJIS[name] : undefined;
	const holidayLabel = name
		? `${name}${emoji ? ` ${emoji}` : ""}`
		: "a holiday";

	if (hasWeekend && hasHoliday) {
		return `the weekend and ${holidayLabel}`;
	}
	if (hasHoliday) {
		return holidayLabel;
	}
	return "the weekend";
});
</script>
