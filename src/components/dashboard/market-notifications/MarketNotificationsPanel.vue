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
			<FadeTransition>
				<div
					v-if="statusMessage"
					class="absolute top-3 right-3 flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium z-10 border"
					:class="STATUS_TONE_CLASSES[statusTone]"
					role="status"
					aria-live="polite"
					:aria-busy="isSaving"
					:data-tone="statusTone"
				>
					<ArrowPathIcon
						v-show="isSaving"
						class="animate-spin size-3 shrink-0"
						aria-hidden="true"
					/>
					{{ statusMessage }}
				</div>
			</FadeTransition>

			<div :class="`card-accent ${CARD_GRADIENT_ACCENTS.success}`"></div>
		<div class="card-body">
		<fieldset :disabled="isSaving" class="min-w-0">
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
					<div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4 shrink-0">
						<label class="inline-flex items-center gap-1.5" :class="!notificationSetupBlocked && emailEnabled ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'">
							<input
								type="checkbox"
								v-model="priceAlertsIncludeEmail"
								:disabled="notificationSetupBlocked || !emailEnabled"
								class="rounded border-edge-strong text-emerald-600 focus:ring-emerald-500 h-4 w-4 cursor-pointer"
								aria-label="Enable email for smart price alerts"
								aria-describedby="market_asset_price_alerts_enabled_description"
							/>
							<span class="text-sm font-normal text-label" aria-hidden="true">Email</span>
						</label>
						<label class="inline-flex items-center gap-1.5" :class="smsReady && !notificationSetupBlocked ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'">
							<input
								type="checkbox"
								v-model="priceAlertsIncludeSms"
								:disabled="notificationSetupBlocked || !smsReady"
								class="rounded border-edge-strong text-emerald-600 focus:ring-emerald-500 h-4 w-4 cursor-pointer"
								aria-label="Enable SMS for smart price alerts"
								aria-describedby="market_asset_price_alerts_enabled_description"
							/>
							<span class="text-sm font-normal text-label" aria-hidden="true">SMS</span>
						</label>
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
					<div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4 shrink-0">
						<label class="inline-flex items-center gap-1.5" :class="!notificationSetupBlocked && emailEnabled ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'">
							<input
								type="checkbox"
								v-model="marketIncludeEmail"
								:disabled="notificationSetupBlocked || !emailEnabled"
								class="rounded border-edge-strong text-emerald-600 focus:ring-emerald-500 h-4 w-4 cursor-pointer"
								aria-label="Enable email for scheduled price notifications"
								aria-describedby="market_scheduled_asset_price_enabled_description"
							/>
							<span class="text-sm font-normal text-label" aria-hidden="true">Email</span>
						</label>
						<label class="inline-flex items-center gap-1.5" :class="smsReady && !notificationSetupBlocked ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'">
							<input
								type="checkbox"
								v-model="marketIncludeSms"
								:disabled="notificationSetupBlocked || !smsReady"
								class="rounded border-edge-strong text-emerald-600 focus:ring-emerald-500 h-4 w-4 cursor-pointer"
								aria-label="Enable SMS for scheduled price notifications"
								aria-describedby="market_scheduled_asset_price_enabled_description"
							/>
							<span class="text-sm font-normal text-label" aria-hidden="true">SMS</span>
						</label>
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
							:minTime="marketMinTime"
							:maxTime="marketMaxTime"
							:marketHoursCrossMidnightHint="marketHoursCrossMidnightHint"
							:is24="is24"
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
					name="price_targets_include_email"
					:value="priceTargetsIncludeEmail ? 'on' : 'off'"
				/>
				<input
					type="hidden"
					name="price_targets_include_sms"
					:value="priceTargetsIncludeSms ? 'on' : 'off'"
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
					<div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4 shrink-0">
						<label class="inline-flex items-center gap-1.5" :class="!notificationSetupBlocked && emailEnabled ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'">
							<input
								type="checkbox"
								v-model="priceTargetsIncludeEmail"
								:disabled="notificationSetupBlocked || !emailEnabled"
								class="rounded border-edge-strong text-emerald-600 focus:ring-emerald-500 h-4 w-4 cursor-pointer"
								aria-label="Enable email for price targets"
								aria-describedby="price_targets_description"
							/>
							<span class="text-sm font-normal text-label" aria-hidden="true">Email</span>
						</label>
						<label class="inline-flex items-center gap-1.5" :class="smsReady && !notificationSetupBlocked ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'">
							<input
								type="checkbox"
								v-model="priceTargetsIncludeSms"
								:disabled="notificationSetupBlocked || !smsReady"
								class="rounded border-edge-strong text-emerald-600 focus:ring-emerald-500 h-4 w-4 cursor-pointer"
								aria-label="Enable SMS for price targets"
								aria-describedby="price_targets_description"
							/>
							<span class="text-sm font-normal text-label" aria-hidden="true">SMS</span>
						</label>
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
import ArrowPathIcon from "../../../icons/arrow-path.svg?component";
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
	STATUS_TONE_CLASSES,
	US_MARKET_TIMEZONE,
} from "../../../lib/constants";
import {
	type AlertMoveSize,
	normalizeMoveSize,
} from "../../../lib/market-notifications/alert-profile";
import {
	formatMinutesAsLocalTime,
	getLastMarketClose,
	getMarketNotificationLocalRange,
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
import SetupRequiredNotice from "../shared/SetupRequiredNotice.vue";
import { useScheduledUpdateTiming } from "./helpers";
import ScheduledUpdateControls from "./ScheduledUpdateControls.vue";

interface Props {
	emailEnabled: boolean;
	phoneVerified: boolean;
	hasTrackedAssets: boolean;
	trackedAssets?: InitialAsset[];
}

const props = withDefaults(defineProps<Props>(), {
	trackedAssets: () => [],
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
const marketNotificationsEnabled = computed(
	() => marketIncludeEmail.value || marketIncludeSms.value,
);

const priceAlertsIncludeEmail = ref(user.value.market_asset_price_alerts_include_email);
const priceAlertsIncludeSms = ref(user.value.market_asset_price_alerts_include_sms);
const priceAlertsEnabled = computed(
	() => priceAlertsIncludeEmail.value || priceAlertsIncludeSms.value,
);
const priceTargetsIncludeEmail = ref(user.value.price_targets_include_email);
const priceTargetsIncludeSms = ref(user.value.price_targets_include_sms);

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
const MINUTES_PER_DAY = MAX_SCHEDULED_UPDATE_MINUTES + 1;

// [threshold in minutes, increment] — checked high-to-low
const QUICK_ADD_INCREMENTS: [number, number][] = [
	[23 * 60 + 58, 1],
	[23 * 60 + 45, 5],
	[23 * 60 + 30, 15],
	[23 * 60, 30],
	[21 * 60, 60],
];

function getQuickAddIncrementMinutes(latestMinutes: number): number {
	for (const [threshold, increment] of QUICK_ADD_INCREMENTS) {
		if (latestMinutes >= threshold) return increment;
	}
	return 180;
}

function getNextQuickAddMinute(
	existingTimes: number[],
	fallbackLatest: number,
): number | null {
	const normalized = normalizeScheduledTimes(existingTimes);
	const latestMinutes =
		normalized.length > 0
			? normalized[normalized.length - 1]
			: fallbackLatest;
	const incrementMinutes = getQuickAddIncrementMinutes(latestMinutes);
	let candidate = latestMinutes + incrementMinutes;
	if (candidate > MAX_SCHEDULED_UPDATE_MINUTES) {
		candidate = 0;
	}
	const existingSet = new Set(normalized);

	for (let offset = 0; offset < MINUTES_PER_DAY; offset += 1) {
		const minute = (candidate + offset) % MINUTES_PER_DAY;
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

const scheduledUpdateTimesMinutes = ref<number[]>(
	normalizeScheduledTimes(user.value.market_scheduled_asset_price_times ?? []),
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
	return getNextQuickAddMinute(times, 0) !== null;
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
	return getMarketNotificationLocalRange(tz);
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

/** When the market window crosses midnight locally, show this hint so users know only 10:00 AM–3:59 PM ET is accepted. */
const marketHoursCrossMidnightHint = computed<string | null>(() => {
	const r = marketLocalRange.value;
	if (!r || r.min <= r.max) return null;
	return "In your timezone the valid window (10:00 AM–3:59 PM ET) crosses midnight. Only times within that ET window are accepted.";
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
watch(
	() => user.value.market_asset_price_alert_move_size,
	(value) => {
		priceAlertMoveSize.value = normalizeMoveSize(value);
	},
);
watch(
	() => user.value.market_scheduled_asset_price_times,
	(value) => {
		scheduledUpdateTimesMinutes.value = normalizeScheduledTimes(value ?? []);
	},
);

const nextSendAt = computed(
	() =>
		savedScheduledData.value?.market_scheduled_asset_price_next_send_at ??
			user.value.market_scheduled_asset_price_next_send_at ??
			null,
);
const is24 = computed(() => user.value.use_24_hour_time);
const { countdownText, countdownDelayReasons, countdownHolidayName } = useScheduledUpdateTiming({
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
		// Allow Ctrl/Cmd+A, C, V, X
		((event.ctrlKey || event.metaKey) && ["a", "c", "v", "x"].includes(event.key.toLowerCase()))
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
	const cleaned = input.value.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1");
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
	const nextMinutes = getNextQuickAddMinute(times, 0);
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
