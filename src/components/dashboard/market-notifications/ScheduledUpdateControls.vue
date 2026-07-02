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
						Choose up to {{ maxTimes }} time slots. Times shown in
						<a href="/profile#timezone-heading" class="link-primary">your local timezone</a>, anchored to
						US market hours (4:30 AM – 7:30 PM ET). Notifications send whenever US markets are trading
						(pre-market, regular, or after-hours). Sends are skipped on weekends, full-day holidays, and
						after early-close days (~3 per year).
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
						input-id="scheduled_update_time_initial"
						input-name="scheduled_update_time_initial"
						:initial-time="null"
						placeholder="Select notification time"
						input-aria-label="Pick a delivery time"
						:input-aria-describedby="marketHoursCrossMidnightHint ? MARKET_HOURS_HINT_ID : undefined"
						:disabled="timePickerDisabled"
						:is24="is24"
						:min-time-override="props.minTime ?? undefined"
						:max-time-override="props.maxTime ?? undefined"
						:disabled-range-tooltip="DISABLED_RANGE_TOOLTIP"
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
				v-for="item in chipItems"
				:key="`${item.index}-${item.time}`"
			>
				<TimePicker
					:input-id="`scheduled_update_time_${item.index}`"
					:input-name="`scheduled_update_time_${item.index}`"
					:initial-time="item.time"
					placeholder="Select notification time"
					:input-aria-label="item.ariaLabel"
					:input-aria-describedby="marketHoursCrossMidnightHint ? MARKET_HOURS_HINT_ID : undefined"
					:disabled="timePickerDisabled"
					clearable
					:clear-aria-label="`Remove delivery time ${item.index + 1}`"
					:is24="is24"
					:min-time-override="props.minTime ?? undefined"
					:max-time-override="props.maxTime ?? undefined"
					:disabled-range-tooltip="DISABLED_RANGE_TOOLTIP"
					:has-trailing-content="item.hasBadge"
					@time-change="emit('time-change', item.index, $event)"
					@clear="emit('remove-time', item.index)"
				>
					<template v-if="item.hasBadge" #trailing>
						<SessionBadge :session="item.session as 'pre' | 'after'" />
					</template>
				</TimePicker>
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
import { computed } from "vue";

// ?component suffix required: Astro Icon cannot be used in Vue; vite-svg-loader compiles this to a Vue component.
import BellAlertIcon from "../../../icons/bell-alert.svg?component";
import PlusIcon from "../../../icons/plus.svg?component";
import PresentationChartLineIcon from "../../../icons/presentation-chart-line.svg?component";
import { userLocalToEtMinute } from "../../../lib/time/conversion";
import { getScheduledMarketSession } from "../../../lib/time/market/session";
import { parseTimeToMinutes } from "../../../lib/time/parse";
import type { ActiveMarketSession } from "../../../lib/types";
import StatusMessage from "../../StatusMessage.vue";
import { useHydrated } from "../../useHydrated";
import TimePicker from "../shared/TimePicker.vue";
import SessionBadge from "./SessionBadge.vue";

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
	countdownDelayReasons: Array<"weekend" | "holiday" | "half-day-after-close">;
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
	/** IANA timezone for classifying each scheduled time as pre-market / regular / after-hours. */
	userTimezone: string;
}

const props = defineProps<Props>();

const isHydrated = useHydrated();

const emit = defineEmits<{
	(event: "time-change", index: number, value: string): void;
	(event: "add-time"): void;
	(event: "add-initial-time", value: string): void;
	(event: "add-after-open"): void;
	(event: "remove-time", index: number): void;
}>();

const serializedTimes = computed(() => JSON.stringify(props.scheduledUpdateTimes));

function sessionFor(time: string): ActiveMarketSession | null {
	if (!props.userTimezone) return null;
	const localMin = parseTimeToMinutes(time);
	if (localMin === null) return null;
	const etMin = userLocalToEtMinute(localMin, props.userTimezone);
	return getScheduledMarketSession(etMin);
}

type ChipItem = {
	time: string;
	index: number;
	session: ActiveMarketSession | null;
	hasBadge: boolean;
	ariaLabel: string;
};

const chipItems = computed<ChipItem[]>(() =>
	props.scheduledUpdateTimes.map((time, index) => {
		const session = sessionFor(time);
		const hasBadge = session === "pre" || session === "after";
		const sessionSuffix = hasBadge
			? `, ${session === "pre" ? "pre-market" : "after-hours"} session`
			: "";
		return {
			time,
			index,
			session,
			hasBadge,
			ariaLabel: `Delivery time ${index + 1}${sessionSuffix}`,
		};
	}),
);

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
	const hasHalfDay = reasons.includes("half-day-after-close");
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
	if (hasHalfDay) {
		return name ? `${name} early close${emoji ? ` ${emoji}` : ""}` : "an early close";
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
