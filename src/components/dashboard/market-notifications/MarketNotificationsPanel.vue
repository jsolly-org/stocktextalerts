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

			<div :class="`card-accent ${CARD_GRADIENT_ACCENTS.success}`"></div>
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
				:needsTrackedAssets="needsTrackedAssets"
				:needsChannelSelection="needsChannelSelection"
				:needsPhoneVerification="needsPhoneVerification"
				:phoneVerificationSectionId="phoneVerificationSectionId"
			/>

			<div
				class="rounded-xl border border-edge bg-surface p-4 transition-opacity duration-200"
				:class="{ 'opacity-50': notificationSetupBlocked }"
			>
				<div class="flex items-center justify-between gap-3">
					<input
						type="hidden"
						name="market_asset_price_alerts_enabled"
						:value="priceAlertsEnabled ? 'on' : 'off'"
					/>
					<input
						type="hidden"
						name="market_asset_price_alerts_include_email"
						:value="priceAlertsIncludeEmail ? 'on' : 'off'"
					/>
					<input
						type="hidden"
						name="market_asset_price_alerts_include_sms"
						:value="priceAlertsIncludeSms ? 'on' : 'off'"
					/>
					<input
						type="hidden"
						name="market_asset_price_alerts_include_telegram"
						:value="priceAlertsIncludeTelegram ? 'on' : 'off'"
					/>
					<input
						type="hidden"
						name="market_asset_price_alert_move_size"
						:value="priceAlertMoveSize"
					/>
					<div class="min-w-0">
						<div class="flex items-center gap-2">
							<span
								id="market_asset_price_alerts_enabled_label"
								class="text-base font-semibold text-heading"
							>
								Smart Price Alerts
							</span>
							<MassiveLogoIcon class="h-4.5 w-auto shrink-0" aria-label="Powered by Massive" role="img" />
							<GrokLogoLightIcon class="h-4.5 w-auto shrink-0 dark:hidden" aria-label="Powered by Grok" role="img" />
							<GrokLogoDarkIcon class="hidden h-4.5 w-auto shrink-0 dark:inline" aria-label="Powered by Grok" role="img" />
						</div>
						<p id="market_asset_price_alerts_enabled_description" class="text-sm text-body-secondary mt-0.5">
							Automatically detects unusual price movements for your tracked assets during US trading hours. Adapts to each asset's typical volatility — one alert per asset per day.
						</p>
					</div>
					<div class="shrink-0">
						<ChannelMultiSelect
							idPrefix="market_asset_price_alerts"
							labelledby="market_asset_price_alerts_enabled_label"
							:options="priceAlertsChannelOptions"
							@toggle="handlePriceAlertsToggle"
						/>
					</div>
				</div>

				<FadeTransition>
					<div
						v-if="priceAlertsEnabled"
						class="mt-3 border-t border-divider pt-3 pl-3 sm:pl-4"
					>
						<fieldset :disabled="notificationSetupBlocked">
							<legend class="sr-only">Alert sensitivity</legend>
							<p id="price-alert-move-size-help" class="text-sm text-label mb-1.5">How sensitive should anomaly detection be?</p>
							<div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
								<label
									v-for="option in moveSizeOptions"
									:key="option.value"
									class="rounded-lg border px-2.5 py-2 text-sm text-label cursor-pointer transition-colors duration-150 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-emerald-500"
									:class="priceAlertMoveSize === option.value ? 'border-emerald-500 bg-emerald-500/10' : 'border-edge bg-surface-alt hover:border-edge-strong'"
								>
									<input
										v-model="priceAlertMoveSize"
										type="radio"
										name="price_alert_move_size"
										:value="option.value"
										class="h-4 w-4 border-edge-strong text-emerald-600 focus:ring-0 align-middle"
									/>
									<span class="ml-1.5 align-middle">{{ option.label }}</span>
									<p class="mt-1 text-xs text-muted">{{ option.description }}</p>
								</label>
							</div>
						</fieldset>
					</div>
				</FadeTransition>
				</div>

			<div
				class="mt-4 rounded-xl border border-edge bg-surface p-4 transition-opacity duration-200"
				:class="{ 'opacity-50': notificationSetupBlocked }"
			>
				<div class="flex items-center justify-between gap-3">
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
						name="market_scheduled_asset_price_include_sms"
						:value="marketIncludeSms ? 'on' : 'off'"
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
							idPrefix="market_scheduled_asset_price"
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
							:scheduledUpdateTimes="scheduledUpdateTimes"
							:needsChannelSelection="notificationSetupBlocked"
							:timePickerDisabled="timePickerDisabled"
							:canAddTime="canAddTime"
							:canAddAfterOpen="canAddAfterOpen"
							:afterOpenLabel="afterOpenLabel"
							:maxTimes="MAX_DELIVERY_TIMES"
							:maxTimesReached="maxTimesReached"
							:countdownText="countdownText"
							:countdownDelayReasons="countdownDelayReasons"
							:countdownHolidayName="countdownHolidayName"
							:countdownDstShift="countdownDstShift"
							:minTime="marketMinTime"
							:maxTime="marketMaxTime"
							:marketHoursCrossMidnightHint="marketHoursCrossMidnightHint"
							:is24="is24"
							:userTimezone="timezone"
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
					name="price_move_alerts_include_sms"
					:value="priceMoveAlertsIncludeSms ? 'on' : 'off'"
				/>
				<input
					type="hidden"
					name="price_move_alerts_include_telegram"
					:value="priceMoveAlertsIncludeTelegram ? 'on' : 'off'"
				/>
				<div class="flex items-start justify-between gap-3">
					<div class="min-w-0">
						<span
							id="price_move_alerts_label"
							class="text-base font-semibold text-heading"
						>
							5% Price Move Alerts
						</span>
						<p id="price_move_alerts_description" class="text-sm text-body-secondary mt-0.5">
							Get notified whenever any asset you track moves 5% or more in a trading day. Measured from yesterday's close on the first alert, then re-triggered on each additional 5% move from the last alert.
						</p>
						<p class="text-xs text-muted mt-1">
							Applies to every asset in your watchlist — stocks and ETFs alike (although a 5% ETF move is rare). Independent of your other price alerts.
						</p>
					</div>
					<div class="shrink-0">
						<ChannelMultiSelect
							idPrefix="price_move_alerts"
							labelledby="price_move_alerts_label"
							:options="priceMoveChannelOptions"
							@toggle="handlePriceMoveToggle"
						/>
					</div>
				</div>
			</div>

			<div
				class="mt-4 rounded-xl border border-edge bg-surface p-4 transition-opacity duration-200"
				:class="{ 'opacity-50': notificationSetupBlocked }"
			>
				<input
					type="hidden"
					name="price_targets_include_email"
					:value="priceTargetsIncludeEmail ? 'on' : 'off'"
				/>
				<input
					type="hidden"
					name="price_targets_include_sms"
					:value="priceTargetsIncludeSms ? 'on' : 'off'"
				/>
				<input
					type="hidden"
					name="price_targets_include_telegram"
					:value="priceTargetsIncludeTelegram ? 'on' : 'off'"
				/>
				<div class="flex items-start justify-between gap-3 mb-3">
					<div class="min-w-0">
						<span
							id="price_targets_label"
							class="text-base font-semibold text-heading"
						>
							Price Targets
						</span>
						<p id="price_targets_description" class="text-sm text-body-secondary mt-0.5">
							Set a target price on any watchlist asset. Get notified once when it's hit, then the target clears automatically.
						</p>
					</div>
					<div class="shrink-0">
						<ChannelMultiSelect
							idPrefix="price_targets"
							labelledby="price_targets_label"
							:options="priceTargetsChannelOptions"
							@toggle="handlePriceTargetsToggle"
						/>
					</div>
				</div>

				<FadeTransition>
					<div v-if="!notificationSetupBlocked">
						<div class="border-t border-divider pt-3">
							<div
								v-if="trackedAssets.length === 0"
								class="text-sm text-muted py-4 text-center"
							>
								Add assets to your watchlist to set price targets.
							</div>
							<div v-else class="space-y-2">
								<div
									v-for="asset in trackedAssets"
									:key="asset.symbol"
									class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-edge bg-surface-alt px-3 py-2"
								>
									<AssetBadge :type="asset.type as 'stock' | 'etf'" :symbol="asset.symbol" :icon-url="asset.icon_url" />
									<div class="min-w-0 flex-1">
										<div class="flex items-center gap-2 min-w-0">
											<span class="text-sm font-semibold text-heading shrink-0">{{ asset.symbol }}</span>
											<span
												v-if="getCurrentPrice(asset.symbol) !== null"
												class="inline-flex items-center rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs tabular-nums text-emerald-700 dark:text-emerald-400 truncate"
											>{{ formatCurrentPrice(getCurrentPrice(asset.symbol) ?? 0) }}</span>
										</div>
										<span class="text-xs text-muted truncate block">{{ asset.name }}</span>
									</div>

									<div class="flex items-center gap-2 basis-full sm:basis-auto ml-auto">
										<span
											class="w-3 text-xs text-center"
											:class="getTargetDirection(asset.symbol) === 'above' ? 'text-emerald-600' : getTargetDirection(asset.symbol) === 'below' ? 'text-red-500' : 'invisible'"
											aria-hidden="true"
										>{{ getTargetDirection(asset.symbol) === 'above' ? '▲' : '▼' }}</span>

										<div class="relative">
											<span class="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted pointer-events-none">$</span>
											<input
												type="text"
												inputmode="decimal"
												pattern="[0-9]*\.?[0-9]*"
												:value="getTargetValue(asset.symbol)"
												:placeholder="'Target'"
												class="price-target-input w-24 pl-5 pr-2 py-1 text-base sm:text-sm text-right rounded-md border border-edge bg-surface focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 placeholder:text-muted"
												:aria-label="`Price target for ${asset.symbol}`"
												@input="handleTargetInput(asset.symbol, $event)"
												@keydown="filterNumericInput"
												@keydown.enter.prevent="handleSaveTarget(asset.symbol)"
											/>
										</div>

										<div class="w-12 flex justify-center">
											<button
												v-if="hasPendingInput(asset.symbol)"
												type="button"
												class="price-target-action px-2 py-1 rounded-md text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-500 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
												:disabled="isSavingTarget(asset.symbol)"
												:aria-label="`Save price target for ${asset.symbol}`"
												@click="handleSaveTarget(asset.symbol)"
											>
												{{ isSavingTarget(asset.symbol) ? '...' : 'Save' }}
											</button>
											<button
												v-else-if="hasTarget(asset.symbol)"
												type="button"
												class="p-1 rounded text-muted hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors cursor-pointer"
												:aria-label="`Clear price target for ${asset.symbol}`"
												@click="clearTarget(asset.symbol)"
											>
												<XMarkIcon class="size-4" aria-hidden="true" />
											</button>
										</div>
									</div>
								</div>
							</div>
						</div>

						<FadeTransition>
							<p
								v-if="targetSaveError"
								class="mt-2 text-xs text-red-600"
								role="alert"
							>
								{{ targetSaveError }}
							</p>
						</FadeTransition>

						<div class="mt-3 space-y-1 text-xs text-muted">
							<p v-if="marketOpen">Prices as of {{ pricesFetchedAtLabel ?? 'page load' }} ET. Refresh the page for the latest prices.</p>
							<p v-else>Market closed. Prices as of last close{{ lastCloseLabel ? `, ${lastCloseLabel}` : '' }}.</p>
							<p>Prices are checked every minute during market hours. If a price briefly crosses your target and bounces back within the same minute, the notification may not be sent.</p>
						</div>
					</div>
				</FadeTransition>
			</div>

			</fieldset>
			</div>
		</section>
	</form>

</template>

<script lang="ts" setup>
import { computed, onMounted, type Ref, ref, toRefs, watch } from "vue";
// ?component suffix required: Astro Icon cannot be used in Vue; vite-svg-loader compiles this to a Vue component.
import GrokLogoDarkIcon from "../../../icons/grok-dark.svg?component";
import GrokLogoLightIcon from "../../../icons/grok-light.svg?component";
import InformationCircleIcon from "../../../icons/information-circle-20.svg?component";
import MassiveLogoIcon from "../../../icons/massive.svg?component";
import XMarkIcon from "../../../icons/x-mark.svg?component";
import {
	CARD_GRADIENT_ACCENTS,
	DASHBOARD_MARKET_FORM_ID,
	DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID,
	DASHBOARD_SECTION_IDS,
	DEFAULT_MARKET_UPDATE_TIME_MINUTES,
	US_MARKET_EARLIEST_NOTIFICATION_EASTERN_MINUTES,
	US_MARKET_LATEST_NOTIFICATION_EASTERN_MINUTES,
	US_MARKET_TIMEZONE,
} from "../../../lib/constants";
import {
	type AlertMoveSize,
	normalizeMoveSize,
} from "../../../lib/market-notifications/alert-profile";
import {
	etMinuteToUserLocal,
	formatMinutesAsLocalTime,
	getLastMarketClose,
	getUsAfterOpenLocalMinutes,
	isMarketCurrentlyOpen,
	minutesToTimeInputValue,
	parseTimeToMinutes,
} from "../../../lib/time/format";
import FadeTransition from "../../FadeTransition.vue";
import AssetBadge from "../assets/AssetBadge.vue";
import type { InitialAsset } from "../assets/types";
import {
	type NotificationPreferencesData,
	useAutoSaveForm,
} from "../composables/useAutoSaveNotificationPreferences";
import { useDashboardUser } from "../composables/useDashboardUser";
import type { ChannelOption } from "../shared/ChannelMultiSelect.vue";
import ChannelMultiSelect from "../shared/ChannelMultiSelect.vue";
import {
	getEmailChannelDisabledTitle,
	getSmsChannelDisabledTitle,
} from "../shared/channel-disabled-titles";
import FormStatusBadge from "../shared/FormStatusBadge.vue";
import SetupRequiredNotice from "../shared/SetupRequiredNotice.vue";
import { useScheduledUpdateTiming } from "./helpers";
import ScheduledUpdateControls from "./ScheduledUpdateControls.vue";

interface Props {
	emailEnabled: boolean;
	phoneVerified: boolean;
	hasTrackedAssets: boolean;
	trackedAssets?: InitialAsset[];
	/**
	 * The user's current market-notification Telegram selections, keyed by
	 * notification_type ("market_asset_price_alerts" | "market_scheduled_asset_price"
	 * | "price_move_alerts" | "price_targets"). Loaded server-side from
	 * `notification_preferences` (channel='telegram', content=''); absent types
	 * default to off. The autosave endpoint persists Telegram to that table but does
	 * NOT echo it back in its snapshot, so these refs are the panel's own source of truth.
	 */
	telegramPrefs?: Record<string, boolean>;
}

const props = withDefaults(defineProps<Props>(), {
	trackedAssets: () => [],
	telegramPrefs: () => ({}),
});
const {
	emailEnabled,
	phoneVerified,
	hasTrackedAssets,
	trackedAssets,
} = toRefs(props);

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
const marketIncludeSms = ref(user.value.market_scheduled_asset_price_include_sms);

const priceAlertsIncludeEmail = ref(user.value.market_asset_price_alerts_include_email);
const priceAlertsIncludeSms = ref(user.value.market_asset_price_alerts_include_sms);
const priceTargetsIncludeEmail = ref(user.value.price_targets_include_email);
const priceTargetsIncludeSms = ref(user.value.price_targets_include_sms);

const priceMoveAlertsIncludeEmail = ref(user.value.price_move_alerts_include_email);
const priceMoveAlertsIncludeSms = ref(user.value.price_move_alerts_include_sms);

/* =============
Telegram per-option state. These prefs live in `notification_preferences`
(channel='telegram', content=''), not the users row, so they initialize from the
server-loaded `telegramPrefs` prop (absent type ⇒ off) and are NOT re-synced from
`user.value` the way the email/sms refs are.
============= */
const marketIncludeTelegram = ref(
	props.telegramPrefs.market_scheduled_asset_price === true,
);
const priceAlertsIncludeTelegram = ref(
	props.telegramPrefs.market_asset_price_alerts === true,
);
const priceMoveAlertsIncludeTelegram = ref(
	props.telegramPrefs.price_move_alerts === true,
);
const priceTargetsIncludeTelegram = ref(props.telegramPrefs.price_targets === true);

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
email/sms already gate `*_enabled`.
============= */
const marketNotificationsEnabled = computed(
	() => marketIncludeEmail.value || marketIncludeSms.value || marketIncludeTelegram.value,
);
const priceAlertsEnabled = computed(
	() =>
		priceAlertsIncludeEmail.value ||
		priceAlertsIncludeSms.value ||
		priceAlertsIncludeTelegram.value,
);

const priceAlertMoveSize = ref<AlertMoveSize>(
	normalizeMoveSize(user.value.market_asset_price_alert_move_size),
);

const moveSizeOptions = [
	{
		value: "significant" as const,
		label: "Significant",
		description: "More sensitive — alerts on moderate anomalies relative to each asset's typical volatility.",
	},
	{
		value: "extreme" as const,
		label: "Extreme",
		description: "Less sensitive — only alerts on large anomalies that strongly deviate from normal trading.",
	},
];

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
	range: { min: number; max: number } | null,
): number | null {
	const normalized = normalizeScheduledTimes(existingTimes);
	// Clamp auto-add to the market window when it's a single daily span.
	// Cross-midnight windows (far-east timezones) fall back to the whole day;
	// users there must pick manually, since wrapping a virtual range gets messy.
	const useMarketRange = range !== null && range.min <= range.max;
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
 *
 * When the user has no timezone yet (rare; pre-onboarding), pass values
 * through unchanged so we don't silently shift the displayed time before the
 * user has selected a timezone.
 */
function hydrateScheduledTimesFromEt(stored: number[] | null | undefined): number[] {
	const tz = user.value.timezone ?? "";
	const raw = stored ?? [];
	if (tz === "") return normalizeScheduledTimes(raw);
	const local = raw.map((et) => etMinuteToUserLocal(et, tz));
	return normalizeScheduledTimes(local);
}

const scheduledUpdateTimesMinutes = ref<number[]>(
	hydrateScheduledTimesFromEt(user.value.market_scheduled_asset_price_times),
);

const phoneVerificationSectionId = `${DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID}-phone-verification-section`;

const scheduledUpdateTimes = computed(() =>
	scheduledUpdateTimesMinutes.value.map((value) => minutesToTimeInputValue(value)),
);

const timezone = computed(() => user.value.timezone ?? "");

const smsOptedOut = computed(() => user.value.sms_opted_out === true);
const smsNotificationsEnabled = computed(() => user.value.sms_notifications_enabled === true);
const smsReady = computed(
	() => phoneVerified.value && !smsOptedOut.value && smsNotificationsEnabled.value,
);
const hasNotificationChannel = computed(
	() =>
		emailEnabled.value ||
		(user.value.market_scheduled_asset_price_include_sms ||
			user.value.market_asset_price_alerts_include_sms ||
			user.value.price_targets_include_sms) &&
			smsReady.value,
);
const needsChannelSelection = computed(() => !hasNotificationChannel.value);
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
const smsDisabledTitle = computed(() =>
	getSmsChannelDisabledTitle({
		smsNotificationsEnabled: smsNotificationsEnabled.value,
		phoneVerified: phoneVerified.value,
		smsOptedOut: smsOptedOut.value,
	}),
);

/* =============
Channel multiselect options. Each option carries its selected/disabled/title so the
multiselect can show every channel while still surfacing why a channel is unavailable.
Email/SMS disabled logic mirrors the prior per-option checkboxes verbatim.
============= */
function emailOption(selected: boolean): ChannelOption {
	return {
		value: "email",
		label: "Email",
		selected,
		disabled: notificationSetupBlocked.value || !emailEnabled.value,
		disabledTitle: emailDisabledTitle.value,
	};
}
function smsOption(selected: boolean): ChannelOption {
	return {
		value: "sms",
		label: "SMS",
		selected,
		disabled: notificationSetupBlocked.value || !smsReady.value,
		disabledTitle: smsDisabledTitle.value,
	};
}
function telegramOption(selected: boolean): ChannelOption {
	return {
		value: "telegram",
		label: "Telegram",
		selected,
		disabled: !telegramConnected.value,
		disabledTitle: telegramDisabledTitle.value,
	};
}

const priceAlertsChannelOptions = computed<ChannelOption[]>(() => [
	emailOption(priceAlertsIncludeEmail.value),
	smsOption(priceAlertsIncludeSms.value),
	telegramOption(priceAlertsIncludeTelegram.value),
]);
const marketScheduledChannelOptions = computed<ChannelOption[]>(() => [
	emailOption(marketIncludeEmail.value),
	smsOption(marketIncludeSms.value),
	telegramOption(marketIncludeTelegram.value),
]);
const priceMoveChannelOptions = computed<ChannelOption[]>(() => [
	emailOption(priceMoveAlertsIncludeEmail.value),
	smsOption(priceMoveAlertsIncludeSms.value),
	telegramOption(priceMoveAlertsIncludeTelegram.value),
]);
const priceTargetsChannelOptions = computed<ChannelOption[]>(() => [
	emailOption(priceTargetsIncludeEmail.value),
	smsOption(priceTargetsIncludeSms.value),
	telegramOption(priceTargetsIncludeTelegram.value),
]);

function handlePriceAlertsToggle(channel: string, selected: boolean) {
	if (channel === "email") priceAlertsIncludeEmail.value = selected;
	else if (channel === "sms") priceAlertsIncludeSms.value = selected;
	else if (channel === "telegram") priceAlertsIncludeTelegram.value = selected;
}
function handleMarketScheduledToggle(channel: string, selected: boolean) {
	if (channel === "email") marketIncludeEmail.value = selected;
	else if (channel === "sms") marketIncludeSms.value = selected;
	else if (channel === "telegram") marketIncludeTelegram.value = selected;
}
function handlePriceMoveToggle(channel: string, selected: boolean) {
	if (channel === "email") priceMoveAlertsIncludeEmail.value = selected;
	else if (channel === "sms") priceMoveAlertsIncludeSms.value = selected;
	else if (channel === "telegram") priceMoveAlertsIncludeTelegram.value = selected;
}
function handlePriceTargetsToggle(channel: string, selected: boolean) {
	if (channel === "email") priceTargetsIncludeEmail.value = selected;
	else if (channel === "sms") priceTargetsIncludeSms.value = selected;
	else if (channel === "telegram") priceTargetsIncludeTelegram.value = selected;
}

const needsPhoneVerification = computed(
	() =>
		(user.value.market_scheduled_asset_price_include_sms ||
			user.value.market_asset_price_alerts_include_sms ||
			user.value.price_targets_include_sms) &&
		!phoneVerified.value,
);
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

const afterOpenLocalMinutes = computed(() => {
	const tz = timezone.value;
	if (tz === "") return null;
	return getUsAfterOpenLocalMinutes(tz);
});

const afterOpenLabel = computed(() => {
	if (afterOpenLocalMinutes.value === null) return null;
	return formatMinutesAsLocalTime(afterOpenLocalMinutes.value, user.value.use_24_hour_time);
});

const hasAfterOpenTime = computed(() => {
	if (afterOpenLocalMinutes.value === null) return true;
	return scheduledUpdateTimesMinutes.value.includes(afterOpenLocalMinutes.value);
});

const canAddAfterOpen = computed(
	() => !timePickerDisabled.value && !hasAfterOpenTime.value && !maxTimesReached.value,
);

const marketLocalRange = computed(() => {
	const tz = timezone.value;
	if (tz === "") return null;
	return {
		min: etMinuteToUserLocal(US_MARKET_EARLIEST_NOTIFICATION_EASTERN_MINUTES, tz),
		max: etMinuteToUserLocal(US_MARKET_LATEST_NOTIFICATION_EASTERN_MINUTES, tz),
	};
});

const marketMinTime = computed<{ hours: number; minutes: number } | null>(() => {
	const r = marketLocalRange.value;
	if (!r || r.min > r.max) return null;
	return { hours: Math.floor(r.min / 60), minutes: r.min % 60 };
});

const marketMaxTime = computed<{ hours: number; minutes: number } | null>(() => {
	const r = marketLocalRange.value;
	if (!r || r.min > r.max) return null;
	return { hours: Math.floor(r.max / 60), minutes: r.max % 60 };
});

/** When the market window crosses midnight locally, show this hint so users know only 4:30 AM–7:30 PM ET is accepted. */
const marketHoursCrossMidnightHint = computed<string | null>(() => {
	const r = marketLocalRange.value;
	if (!r || r.min <= r.max) return null;
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
	() => user.value.market_scheduled_asset_price_include_sms,
	marketIncludeSms,
);
watchUserPreference(
	() => user.value.market_asset_price_alerts_include_email,
	priceAlertsIncludeEmail,
);
watchUserPreference(
	() => user.value.market_asset_price_alerts_include_sms,
	priceAlertsIncludeSms,
);
watchUserPreference(
	() => user.value.price_targets_include_email,
	priceTargetsIncludeEmail,
);
watchUserPreference(
	() => user.value.price_targets_include_sms,
	priceTargetsIncludeSms,
);
watchUserPreference(
	() => user.value.price_move_alerts_include_email,
	priceMoveAlertsIncludeEmail,
);
watchUserPreference(
	() => user.value.price_move_alerts_include_sms,
	priceMoveAlertsIncludeSms,
);
watch(
	() => user.value.market_asset_price_alert_move_size,
	(value) => {
		priceAlertMoveSize.value = normalizeMoveSize(value);
	},
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
			market_scheduled_asset_price_include_sms: newData.market_scheduled_asset_price_include_sms,
			market_scheduled_asset_price_times: newData.market_scheduled_asset_price_times,
			market_scheduled_asset_price_next_send_at: newData.market_scheduled_asset_price_next_send_at,
			// Keep other panels' scheduling in sync with the server response.
			daily_digest_next_send_at: newData.daily_digest_next_send_at,
			asset_events_next_send_at: newData.asset_events_next_send_at,
			// Sync price alerts state from server response
			...(newData.market_asset_price_alerts_enabled !== undefined && {
				market_asset_price_alerts_enabled: newData.market_asset_price_alerts_enabled,
			}),
			...(newData.market_asset_price_alerts_include_email !== undefined && {
				market_asset_price_alerts_include_email: newData.market_asset_price_alerts_include_email,
			}),
			...(newData.market_asset_price_alerts_include_sms !== undefined && {
				market_asset_price_alerts_include_sms: newData.market_asset_price_alerts_include_sms,
			}),
			...(newData.market_asset_price_alert_move_size !== undefined && {
				market_asset_price_alert_move_size: newData.market_asset_price_alert_move_size,
			}),
			...(newData.price_targets_include_email !== undefined && {
				price_targets_include_email: newData.price_targets_include_email,
			}),
			...(newData.price_targets_include_sms !== undefined && {
				price_targets_include_sms: newData.price_targets_include_sms,
			}),
			...(newData.price_move_alerts_include_email !== undefined && {
				price_move_alerts_include_email: newData.price_move_alerts_include_email,
			}),
			...(newData.price_move_alerts_include_sms !== undefined && {
				price_move_alerts_include_sms: newData.price_move_alerts_include_sms,
			}),
			};
		}
	},
);

watch([marketIncludeEmail, marketIncludeSms], ([email, sms]) => {
	if (
		email === user.value.market_scheduled_asset_price_include_email &&
		sms === user.value.market_scheduled_asset_price_include_sms
	) {
		return;
	}
	user.value = {
		...user.value,
		market_scheduled_asset_price_include_email: email,
		market_scheduled_asset_price_include_sms: sms,
		market_scheduled_asset_price_enabled: email || sms,
	};
	notifyChange();
});

watch(priceAlertMoveSize, (moveSize) => {
	if (moveSize === normalizeMoveSize(user.value.market_asset_price_alert_move_size)) {
		return;
	}
	user.value = {
		...user.value,
		market_asset_price_alert_move_size: moveSize,
	};
	notifyChange();
});

watch([priceAlertsIncludeEmail, priceAlertsIncludeSms], ([email, sms]) => {
	if (
		email === user.value.market_asset_price_alerts_include_email &&
		sms === user.value.market_asset_price_alerts_include_sms
	) {
		return;
	}
	user.value = {
		...user.value,
		market_asset_price_alerts_include_email: email,
		market_asset_price_alerts_include_sms: sms,
		market_asset_price_alerts_enabled: email || sms,
	};
	notifyChange();
});

watch([priceTargetsIncludeEmail, priceTargetsIncludeSms], ([email, sms]) => {
	if (
		email === user.value.price_targets_include_email &&
		sms === user.value.price_targets_include_sms
	) {
		return;
	}
	user.value = {
		...user.value,
		price_targets_include_email: email,
		price_targets_include_sms: sms,
	};
	notifyChange();
});

watch([priceMoveAlertsIncludeEmail, priceMoveAlertsIncludeSms], ([email, sms]) => {
	if (
		email === user.value.price_move_alerts_include_email &&
		sms === user.value.price_move_alerts_include_sms
	) {
		return;
	}
	user.value = {
		...user.value,
		price_move_alerts_include_email: email,
		price_move_alerts_include_sms: sms,
	};
	notifyChange();
});

/* =============
Telegram refs have no `users` columns, so unlike email/sms they don't push into
`user.value` — they persist to `notification_preferences` server-side. We still
trigger autosave so the hidden `*_telegram` form fields submit. The hidden
`*_enabled` fields are bound to the master computeds (which include Telegram), so
the form already carries the coupled enable flag.
============= */
watch(
	[
		priceAlertsIncludeTelegram,
		marketIncludeTelegram,
		priceMoveAlertsIncludeTelegram,
		priceTargetsIncludeTelegram,
	],
	() => {
		notifyChange();
	},
);

// ── Price Targets ──
interface PriceTarget {
	symbol: string;
	target_price: number;
	direction: "above" | "below";
	created_at: string;
}

const targets = ref<Map<string, PriceTarget>>(new Map());
const currentPrices = ref<Map<string, number>>(new Map());
const pricesFetchedAt = ref<Date | null>(null);
const pendingInputs = ref<Map<string, string>>(new Map());
const savingTargets = ref<Set<string>>(new Set());
const targetSaveError = ref<string | null>(null);

function formatCurrentPrice(price: number): string {
	return `$${price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const marketOpen = ref(isMarketCurrentlyOpen());

const pricesFetchedAtLabel = computed(() => {
	const d = pricesFetchedAt.value;
	if (!d) return null;
	return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", hour12: !is24.value, timeZone: US_MARKET_TIMEZONE });
});

const lastCloseLabel = computed(() => {
	const lastClose = getLastMarketClose();
	const dateTimePart = lastClose.toLocaleString({
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		hourCycle: is24.value ? "h23" : "h12",
	});
	const relative = lastClose.toRelative();
	return `${dateTimePart} ET (${relative})`;
});

function getCurrentPrice(symbol: string): number | null {
	return currentPrices.value.get(symbol) ?? null;
}

function getTargetValue(symbol: string): string {
	const pending = pendingInputs.value.get(symbol);
	if (pending !== undefined) return pending;
	const target = targets.value.get(symbol);
	return target ? String(target.target_price) : "";
}

function getTargetDirection(symbol: string): "above" | "below" | null {
	const price = currentPrices.value.get(symbol);
	if (price === undefined) return null;

	// Use pending input if the user is typing, otherwise use saved target
	const pending = pendingInputs.value.get(symbol);
	if (pending !== undefined) {
		const num = Number.parseFloat(pending);
		if (!Number.isFinite(num) || num <= 0 || num === price) return null;
		return num > price ? "above" : "below";
	}

	const saved = targets.value.get(symbol);
	if (!saved) return null;
	return saved.target_price > price ? "above" : "below";
}

function hasTarget(symbol: string): boolean {
	return targets.value.has(symbol);
}

function hasPendingInput(symbol: string): boolean {
	const pending = pendingInputs.value.get(symbol);
	if (pending === undefined) return false;
	const saved = targets.value.get(symbol);
	return pending !== (saved ? String(saved.target_price) : "");
}

function isSavingTarget(symbol: string): boolean {
	return savingTargets.value.has(symbol);
}

/** Allow only digits, decimal point, and control keys in price target inputs. */
function filterNumericInput(event: KeyboardEvent) {
	// Allow control keys: backspace, delete, tab, escape, enter, arrows
	if (
		event.key === "Backspace" ||
		event.key === "Delete" ||
		event.key === "Tab" ||
		event.key === "Escape" ||
		event.key === "Enter" ||
		event.key === "ArrowLeft" ||
		event.key === "ArrowRight" ||
		event.key === "Home" ||
		event.key === "End" ||
		// Allow Ctrl/Cmd+A, C, V, X, Z, Y (undo/redo)
		((event.ctrlKey || event.metaKey) &&
			["a", "c", "v", "x", "z", "y"].includes(event.key.toLowerCase())) ||
		((event.ctrlKey || event.metaKey) &&
			event.shiftKey &&
			event.key.toLowerCase() === "z")
	) {
		return;
	}
	// Allow digits and one decimal point
	if (/^[0-9]$/.test(event.key)) return;
	if (event.key === "." && !(event.target as HTMLInputElement).value.includes(".")) return;
	event.preventDefault();
}

function handleTargetInput(symbol: string, event: Event) {
	const input = event.target as HTMLInputElement;
	// Strip any non-numeric characters that might have gotten through (e.g. paste)
	const stripped = input.value.replace(/[^0-9.]/g, "");
	const parts = stripped.split(".");
	const cleaned = parts.length <= 1 ? stripped : `${parts[0]}.${parts.slice(1).join("")}`;
	if (cleaned !== input.value) {
		input.value = cleaned;
	}
	const updated = new Map(pendingInputs.value);
	updated.set(symbol, cleaned);
	pendingInputs.value = updated;
}

async function fetchTargets() {
	try {
		const response = await fetch("/api/price-targets");
		if (!response.ok) return;
		const data = await response.json();
		if (!data.ok) return;

		const map = new Map<string, PriceTarget>();
		for (const t of data.targets) {
			map.set(t.symbol, t);
		}
		targets.value = map;

		if (data.prices) {
			const priceMap = new Map<string, number>();
			for (const [symbol, price] of Object.entries(data.prices)) {
				if (typeof price === "number") priceMap.set(symbol, price);
			}
			currentPrices.value = priceMap;
			marketOpen.value = isMarketCurrentlyOpen();
			if (priceMap.size > 0) {
				pricesFetchedAt.value = new Date();
			}
		}
	} catch {
		// Silently fail — targets will just show as empty
	}
}

async function saveTarget(symbol: string, targetPrice: number | null) {
	targetSaveError.value = null;
	const updated = new Set(savingTargets.value);
	updated.add(symbol);
	savingTargets.value = updated;
	try {
		const response = await fetch("/api/price-targets/save", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ symbol, target_price: targetPrice }),
		});
		const data = await response.json();
		if (!data.ok) {
			if (data.message === "target_equals_current") {
				targetSaveError.value = "Target price cannot equal the current price.";
			} else if (data.message === "price_unavailable") {
				targetSaveError.value = "Could not fetch current price. Try again.";
			} else {
				targetSaveError.value = "Failed to save target. Please try again.";
			}
			return;
		}

		if (targetPrice === null) {
			targets.value.delete(symbol);
			targets.value = new Map(targets.value);
		} else {
			targets.value.set(symbol, {
				symbol,
				target_price: targetPrice,
				direction: data.direction ?? "above",
				created_at: new Date().toISOString(),
			});
			targets.value = new Map(targets.value);
		}
		// Clear pending input after successful save
		const pendingUpdated = new Map(pendingInputs.value);
		pendingUpdated.delete(symbol);
		pendingInputs.value = pendingUpdated;
	} catch {
		targetSaveError.value = "Failed to save target. Please try again.";
	} finally {
		const cleared = new Set(savingTargets.value);
		cleared.delete(symbol);
		savingTargets.value = cleared;
	}
}

function handleSaveTarget(symbol: string) {
	const value = (pendingInputs.value.get(symbol) ?? getTargetValue(symbol)).trim();

	if (value === "") {
		if (hasTarget(symbol)) {
			saveTarget(symbol, null);
		}
		return;
	}

	const num = Number.parseFloat(value);
	if (!Number.isFinite(num) || num <= 0) {
		targetSaveError.value = "Target price must be a positive number.";
		return;
	}

	saveTarget(symbol, num);
}

function clearTarget(symbol: string) {
	const pendingUpdated = new Map(pendingInputs.value);
	pendingUpdated.delete(symbol);
	pendingInputs.value = pendingUpdated;
	saveTarget(symbol, null);
}

onMounted(() => {
	fetchTargets();
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

<style scoped>
/* Make the target field explicitly mobile-safe and avoid Safari double-tap zoom. */
.price-target-input,
.price-target-action {
	touch-action: manipulation;
}
</style>
