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

			<div class="card-accent card-accent-success"></div>
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
				class="rounded-xl border border-edge bg-surface p-4 transition-opacity duration-200"
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
						name="market_scheduled_asset_price_include_email"
						:value="marketIncludeEmail ? 'on' : 'off'"
					/>
					<input
						type="hidden"
						name="market_scheduled_asset_price_include_telegram"
						:value="marketIncludeTelegram ? 'on' : 'off'"
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
						<ChannelMultiSelect
							id-prefix="market_scheduled_asset_price"
							labelledby="market_scheduled_asset_price_enabled_label"
							:options="marketScheduledChannelOptions"
							@toggle="handleMarketScheduledToggle"
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
				class="mt-4 rounded-xl border border-edge bg-surface p-4 transition-opacity duration-200"
				:class="{ 'opacity-50': notificationSetupBlocked }"
			>
				<input
					type="hidden"
					name="price_move_alerts_include_email"
					:value="priceMoveAlertsIncludeEmail ? 'on' : 'off'"
				/>
				<input
					type="hidden"
					name="price_move_alerts_include_telegram"
					:value="priceMoveAlertsIncludeTelegram ? 'on' : 'off'"
				/>
				<div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
					<div class="min-w-0">
						<span
							id="price_move_alerts_label"
							class="text-base font-semibold text-heading"
						>
							Price Move Alerts
						</span>
						<p id="price_move_alerts_description" class="text-sm text-body-secondary mt-0.5">
							Get notified when a tracked stock moves past a threshold you set — as a percent or a dollar change in a single trading day. Measured from yesterday's close on the first alert, then re-triggered on each additional move of that size.
						</p>
						<p class="text-xs text-muted mt-1">
							Set a threshold per stock below. Leave a stock blank to skip it.
						</p>
					</div>
					<div class="shrink-0">
						<ChannelMultiSelect
							id-prefix="price_move_alerts"
							labelledby="price_move_alerts_label"
							:options="priceMoveChannelOptions"
							@toggle="handlePriceMoveToggle"
						/>
					</div>
				</div>

				<FadeTransition>
					<p
						v-if="!notificationSetupBlocked && trackedAssets.length === 0"
						class="mt-3 border-t border-divider pt-3 text-sm text-muted"
					>
						Add assets to your watchlist to set price-move thresholds.
					</p>
					<div
						v-else-if="!notificationSetupBlocked"
						class="mt-3 border-t border-divider pt-3"
						data-autosave-ignore
					>
						<div class="mb-2 flex items-center justify-between gap-2">
							<p class="text-sm text-label">Per-stock thresholds</p>
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
						<ul class="flex flex-col gap-2">
							<li
								v-for="asset in trackedAssets"
								:key="asset.symbol"
								class="flex items-center gap-2"
							>
								<span class="min-w-0 flex-1 truncate text-sm font-medium text-heading">{{ asset.symbol }}</span>
								<div class="flex shrink-0 items-center gap-1">
									<span v-if="thresholdUnitFor(asset.symbol) === 'dollar'" class="text-sm text-muted">$</span>
									<input
										type="number"
										inputmode="decimal"
										min="0"
										step="any"
										class="w-20 rounded-md border bg-surface-alt px-2 py-1 text-right text-sm text-heading focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500"
										:class="thresholdErrors[asset.symbol] ? 'border-red-500' : 'border-edge'"
										:placeholder="thresholdPlaceholder"
										:aria-label="`Price-move threshold for ${asset.symbol} in ${thresholdUnitFor(asset.symbol) === 'percent' ? 'percent' : 'dollars'}`"
										:aria-invalid="thresholdErrors[asset.symbol] ? 'true' : undefined"
										:value="thresholdValueFor(asset.symbol)"
										@change="handleThresholdValueChange(asset.symbol, $event)"
										@keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
									/>
									<span v-if="thresholdUnitFor(asset.symbol) === 'percent'" class="text-sm text-muted">%</span>
									<div class="inline-flex overflow-hidden rounded-md border border-edge">
										<button
											type="button"
											class="px-2 py-1 text-xs transition-colors duration-150 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-emerald-500"
											:class="thresholdUnitFor(asset.symbol) === 'percent' ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' : 'bg-surface-alt text-muted hover:text-heading'"
											:aria-pressed="thresholdUnitFor(asset.symbol) === 'percent'"
											:aria-label="`Use percent threshold for ${asset.symbol}`"
											@click="setThresholdUnit(asset.symbol, 'percent')"
										>%</button>
										<button
											type="button"
											class="border-l border-edge px-2 py-1 text-xs transition-colors duration-150 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-emerald-500"
											:class="thresholdUnitFor(asset.symbol) === 'dollar' ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' : 'bg-surface-alt text-muted hover:text-heading'"
											:aria-pressed="thresholdUnitFor(asset.symbol) === 'dollar'"
											:aria-label="`Use dollar threshold for ${asset.symbol}`"
											@click="setThresholdUnit(asset.symbol, 'dollar')"
										>$</button>
									</div>
								</div>
							</li>
						</ul>
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
	DEFAULT_PRICE_MOVE_THRESHOLD_PERCENT,
	US_MARKET_EARLIEST_NOTIFICATION_EASTERN_MINUTES,
	US_MARKET_LATEST_NOTIFICATION_EASTERN_MINUTES,} from "../../../lib/constants";
import type { PriceMoveThresholdUnit } from "../../../lib/db/types";
import { etMinuteToUserLocal, getUsAfterOpenLocalMinutes } from "../../../lib/time/conversion";
import {
	formatMinutesAsLocalTime,
	minutesToTimeInputValue,
} from "../../../lib/time/display";
import { parseTimeToMinutes } from "../../../lib/time/parse";
import FadeTransition from "../../FadeTransition.vue";
import { useAutoSaveForm } from "../composables/useAutoSaveNotificationPreferences";
import { useDashboardUser } from "../composables/useDashboardUser";
import { useScheduledUpdateTiming } from "../composables/useScheduledUpdateTiming";
import { DASHBOARD_MARKET_FORM_ID } from "../constants";
import ChannelMultiSelect from "../shared/ChannelMultiSelect.vue";
import { getEmailChannelDisabledTitle } from "../shared/channel-disabled-titles";
import { createChannelOptionBuilders } from "../shared/channel-options";
import FormStatusBadge from "../shared/FormStatusBadge.vue";
import SetupRequiredNotice from "../shared/SetupRequiredNotice.vue";
import type { ChannelOption, InitialAsset, NotificationPreferencesData, PriceMoveThresholdMap } from "../types";
import ScheduledUpdateControls from "./ScheduledUpdateControls.vue";

interface Props {
	emailEnabled: boolean;
	hasTrackedAssets: boolean;
	/** Live tracked-asset list (updated by watchlist edits) — one price-move
	 *  threshold row is rendered per asset. */
	trackedAssets: InitialAsset[];
	/** Per-symbol price-move thresholds loaded server-side; absent = off. */
	priceMoveThresholds: PriceMoveThresholdMap;
	/**
	 * The user's current market-notification Telegram selections, keyed by
	 * notification_type ("market_scheduled_asset_price" | "price_move_alerts").
	 * Loaded server-side from `notification_preferences` (channel='telegram',
	 * content=''); absent types default to off. The autosave endpoint persists
	 * Telegram to that table but does NOT echo it back in its snapshot, so these
	 * refs are the panel's own source of truth.
	 */
	telegramPrefs?: Record<string, boolean>;
}

const props = withDefaults(defineProps<Props>(), {
	telegramPrefs: () => ({}),
});
const { emailEnabled, hasTrackedAssets, trackedAssets } = toRefs(props);

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

const marketIncludeEmail = ref(user.value.market_scheduled_asset_price_include_email);

const priceMoveAlertsIncludeEmail = ref(user.value.price_move_alerts_include_email);

/* =============
Telegram per-option state. These prefs live in `notification_preferences`
(channel='telegram', content=''), not the users row, so they initialize from the
server-loaded `telegramPrefs` prop (absent type ⇒ off) and are NOT re-synced from
`user.value` the way the email refs are.
============= */
const marketIncludeTelegram = ref(
	props.telegramPrefs.market_scheduled_asset_price === true,
);
const priceMoveAlertsIncludeTelegram = ref(
	props.telegramPrefs.price_move_alerts === true,
);

/** Telegram is selectable only once the account is linked (chat id present). */
const telegramConnected = computed(() => user.value.telegram_chat_id != null);
const telegramDisabledTitle = computed(() =>
	telegramConnected.value
		? undefined
		: "Connect Telegram in your notification channels to select this option.",
);

/* =============
Master-flag coupling: the hidden `*_enabled` fields drive whether the notification
fires at all. Telegram must flip them too — otherwise selecting only Telegram would
persist a Telegram pref but leave the feature disabled, so nothing sends. Mirrors how
email already gates `*_enabled`.
============= */
const marketNotificationsEnabled = computed(
	() => marketIncludeEmail.value || marketIncludeTelegram.value,
);

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

const needsChannelSelection = computed(() => !emailEnabled.value);
const needsTrackedAssets = computed(() => !hasTrackedAssets.value);
const notificationSetupBlocked = computed(
	() => needsChannelSelection.value || needsTrackedAssets.value,
);

/**
 * Hover-text reasons for disabled channel toggles. Populated only when the
 * channel itself is unavailable — panel-level blocks (no tracked assets, no
 * channel selected at all) are surfaced via SetupRequiredNotice instead.
 */
const emailDisabledTitle = computed(() =>
	getEmailChannelDisabledTitle(emailEnabled.value),
);

/* =============
Channel multiselect options. Each option carries its selected/disabled/title so the
multiselect can show every channel while still surfacing why a channel is unavailable.
Email disabled logic mirrors the prior per-option checkboxes verbatim.
============= */
const { emailOption, telegramOption } = createChannelOptionBuilders({
	emailDisabled: () => notificationSetupBlocked.value || !emailEnabled.value,
	emailDisabledTitle: () => emailDisabledTitle.value,
	telegramDisabled: () => !telegramConnected.value,
	telegramDisabledTitle: () => telegramDisabledTitle.value,
});

const marketScheduledChannelOptions = computed<ChannelOption[]>(() => [
	emailOption(marketIncludeEmail.value),
	telegramOption(marketIncludeTelegram.value),
]);
const priceMoveChannelOptions = computed<ChannelOption[]>(() => [
	emailOption(priceMoveAlertsIncludeEmail.value),
	telegramOption(priceMoveAlertsIncludeTelegram.value),
]);

function handleMarketScheduledToggle(channel: string, selected: boolean) {
	if (channel === "email") marketIncludeEmail.value = selected;
	else if (channel === "telegram") marketIncludeTelegram.value = selected;
}
function handlePriceMoveToggle(channel: string, selected: boolean) {
	if (channel === "email") priceMoveAlertsIncludeEmail.value = selected;
	else if (channel === "telegram") priceMoveAlertsIncludeTelegram.value = selected;
}

/* =============
Per-stock price-move thresholds. Row presence in price_move_alert_thresholds =
alerts on for that asset. Seeded from the server-loaded map; edits POST to
/api/price-move-alerts (its own table, separate from the notification-prefs
autosave form). A blank value clears the threshold (disables that stock).
============= */
const thresholdInputs = reactive<Record<string, { value: string; unit: PriceMoveThresholdUnit }>>(
	Object.fromEntries(
		Object.entries(props.priceMoveThresholds).map(([symbol, t]) => [
			symbol,
			{ value: String(t.value), unit: t.unit },
		]),
	),
);
const thresholdPlaceholder = String(DEFAULT_PRICE_MOVE_THRESHOLD_PERCENT);

/** Per-symbol failed-save flags (drives aria-invalid + the red row border). */
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
			return `Couldn't save ${symbol} — check the value and retry`;
		default:
			return "";
	}
});

/** Symbols leaving the watchlist take their (server-pruned) thresholds with them —
 *  drop the local entries so a remove-then-re-add can't render a stale armed value. */
watch(trackedAssets, (assets) => {
	const tracked = new Set(assets.map((a) => a.symbol));
	for (const symbol of Object.keys(thresholdInputs)) {
		if (!tracked.has(symbol)) {
			delete thresholdInputs[symbol];
			delete thresholdErrors[symbol];
		}
	}
});

function thresholdValueFor(symbol: string): string {
	return thresholdInputs[symbol]?.value ?? "";
}
function thresholdUnitFor(symbol: string): PriceMoveThresholdUnit {
	return thresholdInputs[symbol]?.unit ?? "percent";
}
function handleThresholdValueChange(symbol: string, event: Event) {
	const target = event.target as HTMLInputElement;
	// A number input with unparseable text reports value "" but badInput=true —
	// treating that as "clear the threshold" would announce a success the user
	// didn't ask for while the garbage text stays visible. Bump the seq too so
	// an earlier in-flight save can't settle afterward and overwrite this error.
	if (target.validity.badInput) {
		thresholdSaveSeq[symbol] = (thresholdSaveSeq[symbol] ?? 0) + 1;
		thresholdErrors[symbol] = true;
		thresholdStatus.value = { kind: "error", symbol };
		return;
	}
	const entry = thresholdInputs[symbol] ?? { value: "", unit: "percent" as PriceMoveThresholdUnit };
	entry.value = target.value;
	thresholdInputs[symbol] = entry;
	void saveThreshold(symbol);
}
function setThresholdUnit(symbol: string, unit: PriceMoveThresholdUnit) {
	const entry = thresholdInputs[symbol] ?? { value: "", unit };
	if (entry.unit === unit) return;
	entry.unit = unit;
	thresholdInputs[symbol] = entry;
	// Persist only when a value is set; changing the unit with no value is a no-op.
	if (entry.value.trim() !== "") void saveThreshold(symbol);
}

async function saveThreshold(symbol: string): Promise<void> {
	const entry = thresholdInputs[symbol];
	const raw = (entry?.value ?? "").trim();
	const unit = entry?.unit ?? "percent";
	const value = raw === "" ? null : Number(raw);
	if (value !== null && (!Number.isFinite(value) || value <= 0)) {
		thresholdErrors[symbol] = true;
		thresholdStatus.value = { kind: "error", symbol };
		return;
	}
	const seq = (thresholdSaveSeq[symbol] ?? 0) + 1;
	thresholdSaveSeq[symbol] = seq;
	thresholdStatus.value = { kind: "saving", symbol };
	let ok = false;
	try {
		const res = await fetch("/api/price-move-alerts", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ symbol, value, unit }),
		});
		const body = (await res.json().catch(() => null)) as { ok?: boolean } | null;
		ok = res.ok && body?.ok === true;
	} catch {
		ok = false;
	}
	// A newer save for this symbol superseded us — its outcome wins.
	if (thresholdSaveSeq[symbol] !== seq) return;
	if (ok) {
		delete thresholdErrors[symbol];
	} else {
		thresholdErrors[symbol] = true;
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
	() => user.value.market_scheduled_asset_price_include_email,
	marketIncludeEmail,
);
watchUserPreference(
	() => user.value.price_move_alerts_include_email,
	priceMoveAlertsIncludeEmail,
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
			market_scheduled_asset_price_include_email: newData.market_scheduled_asset_price_include_email,
			market_scheduled_asset_price_times: newData.market_scheduled_asset_price_times,
			market_scheduled_asset_price_next_send_at: newData.market_scheduled_asset_price_next_send_at,
			// Keep other panels' scheduling in sync with the server response.
			daily_notification_next_send_at: newData.daily_notification_next_send_at,
			// Sync price-move alert channel state from the server response.
			...(newData.price_move_alerts_include_email !== undefined && {
				price_move_alerts_include_email: newData.price_move_alerts_include_email,
			}),
			};
		}
	},
);

watch(marketIncludeEmail, (email) => {
	if (email === user.value.market_scheduled_asset_price_include_email) {
		return;
	}
	user.value = {
		...user.value,
		market_scheduled_asset_price_include_email: email,
		market_scheduled_asset_price_enabled: email,
	};
	notifyChange();
});

watch(priceMoveAlertsIncludeEmail, (email) => {
	if (email === user.value.price_move_alerts_include_email) {
		return;
	}
	user.value = {
		...user.value,
		price_move_alerts_include_email: email,
	};
	notifyChange();
});

/* =============
Telegram refs have no `users` columns, so unlike email they don't push into
`user.value` — they persist to `notification_preferences` server-side. We still
trigger autosave so the hidden `*_telegram` form fields submit. The hidden
`*_enabled` fields are bound to the master computeds (which include Telegram), so
the form already carries the coupled enable flag.
============= */
watch([marketIncludeTelegram, priceMoveAlertsIncludeTelegram], () => {
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

