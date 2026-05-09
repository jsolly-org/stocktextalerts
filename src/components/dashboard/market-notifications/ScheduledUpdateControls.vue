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
					<span class="block text-sm font-normal text-body-secondary mt-0.5">
						Choose up to {{ maxTimes }} time slots. Notifications send anytime US markets are trading
						(pre-market, regular, or after-hours). Pick any time between 4:30 AM and 7:30 PM ET. Sends are
						skipped if markets aren't trading at your scheduled time — this includes early-close days
						(~3 per year), full-day holidays, and the 30-minute gaps between sessions (9:00–9:30 AM and
						4:00–4:30 PM ET). Notifications send within ~10 seconds of your scheduled time.
					</span>
					<span
						v-if="marketHoursCrossMidnightHint"
						:id="MARKET_HOURS_HINT_ID"
						class="block text-sm font-normal text-warning-text mt-1"
						role="status"
					>
						{{ marketHoursCrossMidnightHint }}
					</span>
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
						:inputAriaDescribedby="marketHoursCrossMidnightHint ? MARKET_HOURS_HINT_ID : undefined"
						:disabled="timePickerDisabled"
						:is24="is24"
						:minTimeOverride="props.minTime ?? undefined"
						:maxTimeOverride="props.maxTime ?? undefined"
						:disabledRangeTooltip="DISABLED_RANGE_TOOLTIP"
						@time-change="emit('add-initial-time', $event)"
					/>
					<button
						v-if="afterOpenLabel"
						type="button"
						class="btn btn-sm btn-secondary self-start"
						:disabled="!canAddAfterOpen"
						:aria-label="`Set delivery time to after US market open (${afterOpenLabel})`"
						:title="maxTimesReachedTitle"
						@click="emit('add-after-open')"
					>
						<PresentationChartLineIcon class="size-4 shrink-0 me-1" aria-hidden="true" />
						After open
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
					:inputAriaDescribedby="marketHoursCrossMidnightHint ? MARKET_HOURS_HINT_ID : undefined"
					:disabled="timePickerDisabled"
					clearable
					:clearAriaLabel="`Remove delivery time ${index + 1}`"
					:is24="is24"
					:minTimeOverride="props.minTime ?? undefined"
					:maxTimeOverride="props.maxTime ?? undefined"
					:disabledRangeTooltip="DISABLED_RANGE_TOOLTIP"
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
						:title="maxTimesReachedTitle"
						@click="emit('add-time')"
					>
						<PlusIcon class="size-4 shrink-0 me-1" aria-hidden="true" />
						Add time
					</button>
				<button
					v-if="afterOpenLabel && scheduledUpdateTimes.length > 0"
					type="button"
					class="btn btn-sm btn-secondary self-start"
					:disabled="!canAddAfterOpen"
					:aria-label="`Set delivery time to after US market open (${afterOpenLabel})`"
					:title="maxTimesReachedTitle"
					@click="emit('add-after-open')"
				>
				<PresentationChartLineIcon class="size-4 shrink-0 me-1" aria-hidden="true" />
				After open
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
		<p v-if="countdownDstShift" class="mt-1 text-xs text-body-secondary">
			{{ dstShiftLabel }}
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

const DISABLED_RANGE_TOOLTIP = "Outside US extended-hours window (4:30 AM – 7:30 PM ET)";

/**
 * Stable DOM ID for the cross-midnight hint span. Wired into each
 * TimePicker via `inputAriaDescribedby` so screen readers announce the
 * constraint when the input gains focus.
 */
const MARKET_HOURS_HINT_ID = "scheduled-update-market-hours-hint";

interface Props {
	scheduledUpdateTimes: string[];
	needsChannelSelection: boolean;
	timePickerDisabled: boolean;
	canAddTime: boolean;
	canAddAfterOpen: boolean;
	afterOpenLabel: string | null;
	maxTimes: number;
	maxTimesReached: boolean;
	countdownText: string | null;
	countdownDelayReasons: Array<"weekend" | "holiday">;
	countdownHolidayName: string | null;
	countdownDstShift: "spring-forward" | "fall-back" | null;
	/** Minimum selectable time for the picker (local timezone). */
	minTime: { hours: number; minutes: number } | null;
	/** Maximum selectable time for the picker (local timezone). */
	maxTime: { hours: number; minutes: number } | null;
	/** Force 24-hour / 12-hour display on time pickers. */
	is24?: boolean;
	/** When set, the market window crosses midnight in the user's timezone; show this hint so they know only 4:30 AM–7:30 PM ET is accepted. */
	marketHoursCrossMidnightHint?: string | null;
}

const props = defineProps<Props>();

const isHydrated = ref(false);

const emit = defineEmits<{
	(event: "time-change", index: number, value: string): void;
	(event: "add-time"): void;
	(event: "add-initial-time", value: string): void;
	(event: "add-after-open"): void;
	(event: "remove-time", index: number): void;
}>();

onMounted(() => {
	isHydrated.value = true;
});

const serializedTimes = computed(() => JSON.stringify(props.scheduledUpdateTimes));

const maxTimesReachedTitle = computed<string | undefined>(() =>
	props.maxTimesReached
		? `You've reached the maximum of ${props.maxTimes} delivery times. Remove one to add another.`
		: undefined,
);

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

const dstShiftLabel = computed(() => {
	if (props.countdownDstShift === "spring-forward") {
		return "Daylight saving time begins before then — clocks spring forward 1 hour.";
	}
	if (props.countdownDstShift === "fall-back") {
		return "Daylight saving time ends before then — clocks fall back 1 hour.";
	}
	return "";
});
</script>
