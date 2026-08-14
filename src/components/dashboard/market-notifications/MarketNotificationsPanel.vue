<template>
	<form
		ref="scheduledFormElement"
		:id="DASHBOARD_MARKET_FORM_ID"
		method="POST"
		action="/api/notification-preferences/update"
		aria-label="Market notifications"
		:aria-busy="isSaving"
		@input="handleFormInput"
		@change="handleFormChange"
		@submit="handleFormSubmit"
	>
		<section class="card relative">
			<FormStatusBadge
				:status-message="statusMessage"
				:status-tone="statusTone"
				:is-saving="isSaving"
			/>

		<div class="card-body">
		<fieldset class="min-w-0">
		<header class="mb-4">
			<h2
					:id="DASHBOARD_SECTION_IDS.marketNotifications"
					class="text-xl sm:text-2xl font-bold text-heading transition-opacity duration-200"
					:class="{ 'opacity-50': notificationSetupBlocked }"
				>
					Market Notifications
				</h2>
			<p
				class="text-sm text-body-secondary mt-1"
			>
				Configure market-related notifications for your tracked assets during trading hours.
			</p>
			</header>

			<SetupRequiredNotice
				:needs-tracked-assets="needsTrackedAssets"
				:needs-channel-selection="needsChannelSelection"
			/>

			<div
				class="transition-opacity duration-200"
				:class="{ 'opacity-50': notificationSetupBlocked }"
			>
				<div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
					<input
						type="hidden"
						name="market_scheduled_asset_price_enabled"
						:value="marketNotificationsEnabled ? 'on' : 'off'"
					/>
					<input
						type="hidden"
						name="market_scheduled_asset_price_include"
						:value="marketInclude ? 'on' : 'off'"
					/>
					<div class="min-w-0">
						<div class="flex items-center gap-2">
							<span
								id="market_scheduled_asset_price_enabled_label"
								class="text-base font-semibold text-heading"
							>
								Scheduled Asset Price Notifications
							</span>
							<MassiveLogoIcon class="h-4.5 w-auto shrink-0" aria-label="Powered by Massive" role="img" />
						</div>
						<p id="market_scheduled_asset_price_enabled_description" class="text-sm text-body-secondary mt-0.5">
							Scheduled asset price updates for all tracked assets, including ETFs, at fixed notification times.
						</p>
					</div>
					<div class="shrink-0">
						<ToggleSwitch
							v-model="marketInclude"
							sr-label="Toggle scheduled asset price updates"
							aria-labelledby="market_scheduled_asset_price_enabled_label"
							aria-describedby="market_scheduled_asset_price_enabled_description"
						/>
					</div>
				</div>

				<FadeTransition>
					<div v-if="marketNotificationsEnabled" class="mt-3 border-t border-divider pt-3 pl-3 sm:pl-4">
						<p class="text-sm text-body-secondary mb-3">
							Delivery times for scheduled asset price notifications.
						</p>

						<FadeTransition>
							<p
								v-if="!notificationSetupBlocked && scheduledUpdateTimesMinutes.length === 0"
								class="flex items-start gap-2 rounded-lg px-3 py-2.5 text-sm bg-info-bg border border-info-border text-info-text"
								role="note"
							>
								<InformationCircleIcon class="size-5 shrink-0 mt-0.5" aria-hidden="true" />
								<span>Select one or more delivery times to receive scheduled asset price notifications.</span>
							</p>
						</FadeTransition>

						<ScheduledUpdateControls
							:scheduled-update-times="scheduledUpdateTimes"
							:needs-channel-selection="notificationSetupBlocked"
							:time-picker-disabled="timePickerDisabled"
							:can-add-time="canAddTime"
							:can-add-after-open="canAddAfterOpen"
							:after-open-label="afterOpenLabel"
							:max-times="MAX_DELIVERY_TIMES"
							:max-times-reached="maxTimesReached"
							:countdown-text="countdownText"
							:countdown-delay-reasons="countdownDelayReasons"
							:countdown-holiday-name="countdownHolidayName"
							:countdown-dst-shift="countdownDstShift"
							:min-time="marketMinTime"
							:max-time="marketMaxTime"
							:market-hours-cross-midnight-hint="marketHoursCrossMidnightHint"
							:is24="is24"
							:user-timezone="timezone"
							@time-change="handleTimeChange"
							@add-time="handleAddTime"
							@add-initial-time="handleAddInitialTime"
							@add-after-open="handleAddAfterOpen"
							@remove-time="handleRemoveTime"
						/>
					</div>
				</FadeTransition>
			</div>

			<div
				class="mt-6 border-t border-divider pt-6 transition-opacity duration-200"
				:class="{ 'opacity-50': notificationSetupBlocked }"
			>
				<input
					type="hidden"
					name="price_move_alerts_include"
					:value="priceMoveAlertsInclude ? 'on' : 'off'"
				/>
				<div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
					<div class="min-w-0">
						<div class="flex items-center gap-2">
							<span
								id="price_move_alerts_label"
								class="text-base font-semibold text-heading"
							>
								Price Move Alerts
							</span>
							<MassiveLogoIcon class="h-4.5 w-auto shrink-0" aria-label="Powered by Massive" role="img" />
						</div>
						<p id="price_move_alerts_description" class="text-sm text-body-secondary mt-0.5">
							Get notified when a tracked stock moves 5% from yesterday's close in a single trading day. If the move continues in the same direction, the next alert fires at 2.5%. A move the other way still needs a full 5% from the last alert.
						</p>
					</div>
					<div class="shrink-0">
						<ToggleSwitch
							v-model="priceMoveAlertsInclude"
							sr-label="Toggle price move alerts"
							aria-labelledby="price_move_alerts_label"
							aria-describedby="price_move_alerts_description"
						/>
					</div>
				</div>

				<FadeTransition>
					<div
						v-if="priceMoveAlertsEnabled && !notificationSetupBlocked"
						class="mt-3 border-t border-divider pt-3"
					>
						<p
							v-if="trackedAssets.length === 0"
							class="text-sm text-muted"
						>
							Add assets to your watchlist to enable price-move alerts.
						</p>
						<fieldset
							v-else
							class="min-w-0 border-0 p-0"
							data-autosave-ignore
						>
							<legend class="sr-only">Per-stock alerts</legend>
							<div class="mb-2 flex w-full items-center justify-between gap-2">
								<span class="text-sm text-label" aria-hidden="true">Per-stock alerts</span>
								<span
									class="text-xs transition-opacity duration-200"
									:class="[
										thresholdStatus.kind === 'idle' ? 'opacity-0' : 'opacity-100',
										thresholdStatus.kind === 'error' ? 'text-red-600 dark:text-red-400' : 'text-muted',
									]"
									role="status"
									aria-live="polite"
								>{{ thresholdStatusText }}</span>
							</div>
							<p class="mb-2 text-xs text-muted">
								Turn alerts on or off per stock below.
							</p>
							<div class="mb-2 flex flex-row items-center justify-between gap-3 px-2">
								<span class="select-all-text text-xs font-semibold uppercase tracking-wider text-faint select-none">Select all</span>
								<label class="inline-flex items-center gap-1.5 leading-none">
									<input
										ref="selectAllRef"
										type="checkbox"
										:checked="allPriceMoveChecked"
										class="select-all-checkbox"
										aria-label="Select all tracked stocks for price-move alerts"
										@change="toggleAllPriceMove"
									/>
									<span class="select-all-text text-xs font-semibold text-body-secondary leading-none">All</span>
								</label>
							</div>
							<ul class="flex flex-col gap-2">
								<li
									v-for="asset in trackedAssets"
									:key="asset.symbol"
									class="-mx-2 flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-active"
								>
									<span class="min-w-0 flex-1 flex items-center gap-2 text-sm font-medium text-heading">
										<AssetBadge
											:type="asset.type"
											:symbol="asset.symbol"
											:icon-url="asset.icon_url"
											size="compact"
										/>
										<span class="truncate">{{ asset.symbol }}</span>
									</span>
									<ToggleSwitch
										:model-value="thresholdIsSet(asset.symbol)"
										:sr-label="`Toggle price-move alerts for ${asset.symbol}`"
										@update:model-value="(on: boolean) => setThresholdEnabled(asset.symbol, on)"
									/>
								</li>
							</ul>
						</fieldset>
					</div>
				</FadeTransition>
			</div>

			</fieldset>
			</div>
		</section>
	</form>

</template>

<script lang="ts" setup>
import { computed, type Ref, reactive, ref, toRefs, watch } from "vue";
// ?component suffix required: Astro Icon cannot be used in Vue; vite-svg-loader compiles this to a Vue component.
import InformationCircleIcon from "../../../icons/information-circle-20.svg?component";
import MassiveLogoIcon from "../../../icons/massive.svg?component";
import { DASHBOARD_SECTION_IDS,
	DEFAULT_MARKET_UPDATE_TIME_MINUTES,
	US_MARKET_EARLIEST_NOTIFICATION_EASTERN_MINUTES,
	US_MARKET_LATEST_NOTIFICATION_EASTERN_MINUTES,} from "../../../lib/constants";
import { needsNotificationChannelSelection } from "../../../lib/messaging/delivery-channel";
import { etMinuteToUserLocal, getUsAfterOpenLocalMinutes } from "../../../lib/time/conversion";
import {
	formatMinutesAsLocalTime,
	minutesToTimeInputValue,
} from "../../../lib/time/display";
import { parseTimeToMinutes } from "../../../lib/time/parse";
import FadeTransition from "../../FadeTransition.vue";
import ToggleSwitch from "../../ToggleSwitch.vue";
import AssetBadge from "../assets/AssetBadge.vue";
import { useAutoSaveForm } from "../composables/useAutoSaveNotificationPreferences";
import { useDashboardUser } from "../composables/useDashboardUser";
import { useScheduledUpdateTiming } from "../composables/useScheduledUpdateTiming";
import { DASHBOARD_MARKET_FORM_ID } from "../constants";
import FormStatusBadge from "../shared/FormStatusBadge.vue";
import SetupRequiredNotice from "../shared/SetupRequiredNotice.vue";
import type { InitialAsset, NotificationPreferencesData, PriceMoveThresholdMap } from "../types";
import ScheduledUpdateControls from "./ScheduledUpdateControls.vue";

interface Props {
	hasTrackedAssets: boolean;
	/** Live tracked-asset list (updated by watchlist edits) — one price-move
	 *  threshold row is rendered per asset. */
	trackedAssets: InitialAsset[];
	/** Per-symbol price-move thresholds loaded server-side; absent = off. */
	priceMoveThresholds: PriceMoveThresholdMap;
}

const props = defineProps<Props>();
const { hasTrackedAssets, trackedAssets, priceMoveThresholds } = toRefs(props);

// Inject the shared mutable user ref from DashboardPanels
const user = useDashboardUser();

const scheduledFormElement = ref<HTMLFormElement | null>(null);
const {
	handleFormChange,
	handleFormInput,
	handleFormSubmit,
	isSaving,
	notifyChange,
	savedData: savedScheduledData,
	statusMessage,
	statusTone,
} = useAutoSaveForm<NotificationPreferencesData>({
	formRef: scheduledFormElement,
});

const marketInclude = ref(user.value.market_scheduled_asset_price_include);

const priceMoveAlertsInclude = ref(user.value.price_move_alerts_include);

const marketNotificationsEnabled = computed(() => marketInclude.value);
const priceMoveAlertsEnabled = computed(() => priceMoveAlertsInclude.value);

const MAX_SCHEDULED_UPDATE_MINUTES = 23 * 60 + 59;
const SCHEDULED_UPDATE_INCREMENT_MINUTES = 1;
const MAX_DELIVERY_TIMES = 8;

// [remaining-until-upper-bound, increment] — checked in order; first match wins.
// Default step is 60 min; we shrink near market close so the final slots still fit.
const QUICK_ADD_INCREMENTS: [number, number][] = [
	[2, 1],
	[15, 5],
	[30, 15],
	[60, 30],
];
const QUICK_ADD_DEFAULT_INCREMENT_MINUTES = 60;

function getQuickAddIncrementMinutes(
	latestMinutes: number,
	upperBound: number,
): number {
	const remaining = upperBound - latestMinutes;
	for (const [threshold, increment] of QUICK_ADD_INCREMENTS) {
		if (remaining <= threshold) return increment;
	}
	return QUICK_ADD_DEFAULT_INCREMENT_MINUTES;
}

function getNextQuickAddMinute(
	existingTimes: number[],
	range: { min: number; max: number },
): number | null {
	const normalized = normalizeScheduledTimes(existingTimes);
	// Clamp auto-add to the market window when it's a single daily span.
	// Cross-midnight windows (far-east timezones) fall back to the whole day;
	// users there must pick manually, since wrapping a virtual range gets messy.
	const useMarketRange = range.min <= range.max;
	const lowerBound = useMarketRange ? range.min : 0;
	const upperBound = useMarketRange ? range.max : MAX_SCHEDULED_UPDATE_MINUTES;
	const span = upperBound - lowerBound + 1;

	const inBounds = normalized.filter(
		(t) => t >= lowerBound && t <= upperBound,
	);
	// When no in-bounds times exist yet, anchor the search at lowerBound itself
	// (not lowerBound + increment) so the very first auto-suggestion can land
	// on market open. The wrap branch below still handles the "after the last
	// existing slot" case once times accumulate.
	let candidate: number;
	if (inBounds.length === 0) {
		candidate = lowerBound;
	} else {
		const latestMinutes = inBounds[inBounds.length - 1];
		candidate =
			latestMinutes + getQuickAddIncrementMinutes(latestMinutes, upperBound);
	}
	// If the next step overshoots market close, wrap to the start of the window
	// and scan forward for the first free slot — staying inside the market range.
	if (candidate > upperBound) {
		candidate = lowerBound;
	}
	const existingSet = new Set(normalized);

	for (let offset = 0; offset < span; offset += 1) {
		const minute = lowerBound + ((candidate - lowerBound + offset) % span);
		if (!existingSet.has(minute)) {
			return minute;
		}
	}
	return null;
}

function normalizeScheduledTimes(times: number[]): number[] {
	const filtered = times.filter(
		(value) =>
			Number.isFinite(value) &&
			value >= 0 &&
			value <= MAX_SCHEDULED_UPDATE_MINUTES &&
			value % SCHEDULED_UPDATE_INCREMENT_MINUTES === 0,
	);
	return [...new Set(filtered)].sort((a, b) => a - b);
}

/**
 * Stored `market_scheduled_asset_price_times` are ET-canonical minutes (Phase 9
 * migration). The picker UI works in user-local minutes — convert at the
 * hydration boundary. Submit converts back via `userLocalToEtMinute` in the
 * API handler, so the input → submit path stays in user-local space.
 */
function hydrateScheduledTimesFromEt(stored: number[] | null | undefined): number[] {
	const raw = stored ?? [];
	const local = raw.map((et) => etMinuteToUserLocal(et, user.value.timezone));
	return normalizeScheduledTimes(local);
}

const scheduledUpdateTimesMinutes = ref<number[]>(
	hydrateScheduledTimesFromEt(user.value.market_scheduled_asset_price_times),
);

const scheduledUpdateTimes = computed(() =>
	scheduledUpdateTimesMinutes.value.map((value) => minutesToTimeInputValue(value)),
);

const timezone = computed(() => user.value.timezone);

const needsChannelSelection = computed(() =>
	needsNotificationChannelSelection(user.value),
);
const needsTrackedAssets = computed(() => !hasTrackedAssets.value);
const notificationSetupBlocked = computed(
	() => needsChannelSelection.value || needsTrackedAssets.value,
);


/* =============
Per-stock price-move opt-in. Row presence in price_move_alert_thresholds =
alerts on for that asset at the fixed 5%. Seeded from the server-loaded map;
edits POST `{ symbol, enabled }` to /api/price-move-alerts.
============= */
const thresholdEnabled = reactive<Record<string, boolean>>(
	Object.fromEntries(Object.keys(props.priceMoveThresholds).map((symbol) => [symbol, true])),
);

const selectAllRef = ref<HTMLInputElement | null>(null);
const allPriceMoveChecked = computed(() => {
	const symbols = trackedAssets.value.map((a) => a.symbol);
	return symbols.length > 0 && symbols.every((s) => thresholdEnabled[s] === true);
});
const somePriceMoveChecked = computed(() =>
	trackedAssets.value.some((a) => thresholdEnabled[a.symbol] === true),
);

watch(
	[allPriceMoveChecked, somePriceMoveChecked, trackedAssets],
	() => {
		if (selectAllRef.value) {
			selectAllRef.value.indeterminate = somePriceMoveChecked.value && !allPriceMoveChecked.value;
		}
	},
	{ flush: "post" },
);

/** Per-symbol failed-save flags. */
const thresholdErrors = reactive<Record<string, boolean>>({});
/** Per-symbol monotonic request ids so a stale response can't overwrite a newer one. */
const thresholdSaveSeq: Record<string, number> = {};
const thresholdStatus = ref<{ kind: "idle" | "saving" | "saved" | "error"; symbol: string }>({
	kind: "idle",
	symbol: "",
});
const thresholdStatusText = computed(() => {
	const { kind, symbol } = thresholdStatus.value;
	switch (kind) {
		case "saving":
			return `Saving ${symbol}…`;
		case "saved":
			return `${symbol} saved`;
		case "error":
			return `Couldn't save ${symbol} — retry`;
		default:
			return "";
	}
});

watch(trackedAssets, (assets) => {
	const tracked = new Set(assets.map((a) => a.symbol));
	for (const symbol of Object.keys(thresholdEnabled)) {
		if (!tracked.has(symbol)) {
			delete thresholdEnabled[symbol];
			delete thresholdErrors[symbol];
		}
	}
});

function thresholdIsSet(symbol: string): boolean {
	return thresholdEnabled[symbol] === true;
}

function setThresholdEnabled(symbol: string, enabled: boolean) {
	thresholdEnabled[symbol] = enabled;
	void saveThreshold(symbol, enabled);
}

function toggleAllPriceMove(event: Event) {
	if (!priceMoveAlertsEnabled.value) return;
	const on = (event.target as HTMLInputElement).checked;
	for (const asset of trackedAssets.value) {
		if (thresholdIsSet(asset.symbol) === on) continue;
		setThresholdEnabled(asset.symbol, on);
	}
}

async function saveThreshold(symbol: string, enabled: boolean): Promise<void> {
	const seq = (thresholdSaveSeq[symbol] ?? 0) + 1;
	thresholdSaveSeq[symbol] = seq;
	thresholdStatus.value = { kind: "saving", symbol };
	let ok = false;
	try {
		const res = await fetch("/api/price-move-alerts", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ symbol, enabled }),
		});
		const body = (await res.json().catch(() => null)) as { ok?: boolean } | null;
		ok = res.ok && body?.ok === true;
	} catch {
		ok = false;
	}
	if (thresholdSaveSeq[symbol] !== seq) return;
	if (ok) {
		delete thresholdErrors[symbol];
	} else {
		thresholdErrors[symbol] = true;
		thresholdEnabled[symbol] = !enabled;
	}
	thresholdStatus.value = { kind: ok ? "saved" : "error", symbol };
}

const timePickerDisabled = computed(() => notificationSetupBlocked.value);
const maxTimesReached = computed(
	() => scheduledUpdateTimesMinutes.value.length >= MAX_DELIVERY_TIMES,
);
const canAddTime = computed(() => {
	if (timePickerDisabled.value) {
		return false;
	}
	if (maxTimesReached.value) {
		return false;
	}
	const times = normalizeScheduledTimes(scheduledUpdateTimesMinutes.value);
	// Always possible to add when list is empty
	if (times.length === 0) {
		return true;
	}
	return getNextQuickAddMinute(times, marketLocalRange.value) !== null;
});

const afterOpenLocalMinutes = computed(() => getUsAfterOpenLocalMinutes(timezone.value));

const afterOpenLabel = computed(() =>
	formatMinutesAsLocalTime(afterOpenLocalMinutes.value, user.value.use_24_hour_time),
);

const hasAfterOpenTime = computed(() =>
	scheduledUpdateTimesMinutes.value.includes(afterOpenLocalMinutes.value),
);

const canAddAfterOpen = computed(
	() => !timePickerDisabled.value && !hasAfterOpenTime.value && !maxTimesReached.value,
);

const marketLocalRange = computed(() => ({
	min: etMinuteToUserLocal(US_MARKET_EARLIEST_NOTIFICATION_EASTERN_MINUTES, timezone.value),
	max: etMinuteToUserLocal(US_MARKET_LATEST_NOTIFICATION_EASTERN_MINUTES, timezone.value),
}));

const marketMinTime = computed<{ hours: number; minutes: number } | null>(() => {
	const r = marketLocalRange.value;
	if (r.min > r.max) return null;
	return { hours: Math.floor(r.min / 60), minutes: r.min % 60 };
});

const marketMaxTime = computed<{ hours: number; minutes: number } | null>(() => {
	const r = marketLocalRange.value;
	if (r.min > r.max) return null;
	return { hours: Math.floor(r.max / 60), minutes: r.max % 60 };
});

/** When the market window crosses midnight locally, show this hint so users know only 4:30 AM–7:30 PM ET is accepted. */
const marketHoursCrossMidnightHint = computed<string | null>(() => {
	const r = marketLocalRange.value;
	if (r.min <= r.max) return null;
	return "In your timezone the valid window (4:30 AM–7:30 PM ET) crosses midnight. Only times within that ET window are accepted.";
});

/** Sync a user preference into a local ref so UI and server stay aligned. */
function watchUserPreference<T>(
	getValue: () => T,
	localRef: Ref<T>,
): void {
	watch(getValue, (value) => {
		localRef.value = value;
	});
}

watchUserPreference(
	() => user.value.market_scheduled_asset_price_include,
	marketInclude,
);
watchUserPreference(
	() => user.value.price_move_alerts_include,
	priceMoveAlertsInclude,
);
watch(
	() => user.value.market_scheduled_asset_price_times,
	(value) => {
		scheduledUpdateTimesMinutes.value = hydrateScheduledTimesFromEt(value);
	},
);

const nextSendAt = computed(
	() =>
		savedScheduledData.value?.market_scheduled_asset_price_next_send_at ??
			user.value.market_scheduled_asset_price_next_send_at ??
			null,
);
const is24 = computed(() => user.value.use_24_hour_time);
const {
	countdownText,
	countdownDelayReasons,
	countdownHolidayName,
	countdownDstShift,
} = useScheduledUpdateTiming({
	timezone,
	nextSendAtIso: nextSendAt,
	timeInputs: scheduledUpdateTimes,
	is24,
});

// Update shared user ref directly when auto-save response arrives
watch(
	() => savedScheduledData.value,
	(newData) => {
		if (newData) {
		user.value = {
			...user.value,
			market_scheduled_asset_price_enabled: newData.market_scheduled_asset_price_enabled,
			market_scheduled_asset_price_include: newData.market_scheduled_asset_price_include,
			market_scheduled_asset_price_times: newData.market_scheduled_asset_price_times,
			market_scheduled_asset_price_next_send_at: newData.market_scheduled_asset_price_next_send_at,
			// Keep other panels' scheduling in sync with the server response.
			daily_notification_next_send_at: newData.daily_notification_next_send_at,
			// Sync price-move alert channel state from the server response.
			...(newData.price_move_alerts_include !== undefined && {
				price_move_alerts_include: newData.price_move_alerts_include,
			}),
			};
		}
	},
);

watch(marketInclude, (enabled) => {
	if (enabled === user.value.market_scheduled_asset_price_include) {
		return;
	}
	user.value = {
		...user.value,
		market_scheduled_asset_price_include: enabled,
		market_scheduled_asset_price_enabled: enabled,
	};
	notifyChange();
});

watch(priceMoveAlertsInclude, (enabled) => {
	if (enabled === user.value.price_move_alerts_include) {
		return;
	}
	user.value = {
		...user.value,
		price_move_alerts_include: enabled,
	};
	notifyChange();
});

function handleTimeChange(index: number, value: string) {
	const parsedMinutes = parseTimeToMinutes(value);
	if (parsedMinutes === null) {
		return;
	}
	const updated = [...scheduledUpdateTimesMinutes.value];
	updated[index] = parsedMinutes;
	scheduledUpdateTimesMinutes.value = normalizeScheduledTimes(updated);
	notifyChange();
}

function handleAddTime() {
	if (!canAddTime.value) return;
	const times = normalizeScheduledTimes(scheduledUpdateTimesMinutes.value);
	// When empty, use after-open time as the first suggested time (falls back to 9:00 AM)
	if (times.length === 0) {
		scheduledUpdateTimesMinutes.value = [afterOpenLocalMinutes.value ?? DEFAULT_MARKET_UPDATE_TIME_MINUTES];
		notifyChange();
		return;
	}
	const nextMinutes = getNextQuickAddMinute(times, marketLocalRange.value);
	if (nextMinutes === null) return;
	scheduledUpdateTimesMinutes.value = normalizeScheduledTimes([...times, nextMinutes]);
	notifyChange();
}

function handleAddInitialTime(value: string) {
	const parsedMinutes = parseTimeToMinutes(value);
	if (parsedMinutes === null) {
		return;
	}
	scheduledUpdateTimesMinutes.value = [parsedMinutes];
	notifyChange();
}

function handleAddAfterOpen() {
	if (!canAddAfterOpen.value || afterOpenLocalMinutes.value === null) {
		return;
	}
	const times = normalizeScheduledTimes(scheduledUpdateTimesMinutes.value);
	const baseTimes =
		times.length === 0 ? [afterOpenLocalMinutes.value] : [...times, afterOpenLocalMinutes.value];
	scheduledUpdateTimesMinutes.value = normalizeScheduledTimes(baseTimes);
	notifyChange();
}

function handleRemoveTime(index: number) {
	const updated = [...scheduledUpdateTimesMinutes.value];
	updated.splice(index, 1);
	scheduledUpdateTimesMinutes.value = normalizeScheduledTimes(updated);
	notifyChange();
}

</script>
