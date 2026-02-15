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
				:data-autosave-ignore="isPriceAlertAutosaveLocked ? '' : null"
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
						name="market_asset_price_alert_onboarding_completed"
						:value="priceAlertOnboardingCompleted ? 'on' : 'off'"
					/>
					<input
						type="hidden"
						name="market_asset_price_alert_risk_priority"
						:value="priceAlertRiskPriority"
					/>
					<input
						type="hidden"
						name="market_asset_price_alert_market_context"
						:value="priceAlertMarketContext"
					/>
					<input
						type="hidden"
						name="market_asset_price_alert_move_size"
						:value="priceAlertMoveSize"
					/>
					<input
						type="hidden"
						name="market_asset_price_alert_follow_up_mode"
						:value="priceAlertFollowUpMode"
					/>
					<div class="min-w-0">
						<div class="flex items-center gap-2">
							<span
								id="market_asset_price_alerts_enabled_label"
								class="text-base font-semibold text-heading"
							>
								Realtime Asset Price Alerts
							</span>
							<MassiveLogoIcon class="h-4.5 w-auto shrink-0" aria-label="Powered by Massive" role="img" />
							<GrokLogoLightIcon class="h-4.5 w-auto shrink-0 dark:hidden" aria-label="Powered by Grok" role="img" />
							<GrokLogoDarkIcon class="hidden h-4.5 w-auto shrink-0 dark:inline" aria-label="Powered by Grok" role="img" />
						</div>
						<p id="market_asset_price_alerts_enabled_description" class="text-sm text-body-secondary mt-0.5">
							Immediate alerts for significant price moves during US trading hours.
						</p>
					</div>
					<div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4 shrink-0">
						<label class="inline-flex items-center gap-1.5 cursor-pointer">
							<input
								type="checkbox"
								v-model="priceAlertsIncludeEmail"
								:disabled="notificationSetupBlocked || !emailEnabled"
								class="rounded border-edge-strong text-emerald-600 focus:ring-emerald-500 h-4 w-4 cursor-pointer"
								aria-describedby="market_asset_price_alerts_enabled_description"
							/>
							<span class="text-sm text-label">Email</span>
						</label>
						<label class="inline-flex items-center gap-1.5" :class="smsReady && !notificationSetupBlocked ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'">
							<input
								type="checkbox"
								v-model="priceAlertsIncludeSms"
								:disabled="notificationSetupBlocked || !smsReady"
								class="rounded border-edge-strong text-emerald-600 focus:ring-emerald-500 h-4 w-4 cursor-pointer"
								aria-describedby="market_asset_price_alerts_enabled_description"
							/>
							<span class="text-sm text-label">SMS</span>
						</label>
					</div>
				</div>

				<FadeTransition>
					<div v-if="priceAlertsEnabled && showWizard" key="wizard" class="mt-3 border-t border-divider pt-3 pl-3 sm:pl-4">
						<fieldset :disabled="notificationSetupBlocked">
							<div class="space-y-3">
								<!-- All steps rendered in the same grid cell so the container
								     sizes to the tallest step, preventing layout shift. -->
								<div class="grid [&>*]:col-start-1 [&>*]:row-start-1">
									<div :class="activeRetuneStep === 0 ? 'visible' : 'invisible'" :inert="activeRetuneStep !== 0 || undefined">
										<p class="text-sm text-label mb-1.5">Which moves would you want a text about?</p>
										<div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
											<label
												v-for="option in riskPriorityOptions"
												:key="option.value"
												class="rounded-lg border border-edge bg-surface-alt px-2.5 py-2 text-sm text-label cursor-pointer"
											>
												<input
													v-model="priceAlertRiskPriority"
													type="radio"
													name="price_alert_risk_priority"
													:value="option.value"
													class="h-4 w-4 border-edge-strong text-emerald-600 focus:ring-emerald-500 align-middle"
												/>
												<span class="ml-1.5 align-middle">{{ option.label }}</span>
												<p class="mt-1 text-xs text-muted whitespace-pre-line">{{ option.example }}</p>
											</label>
										</div>
									</div>

									<div :class="activeRetuneStep === 1 ? 'visible' : 'invisible'" :inert="activeRetuneStep !== 1 || undefined">
										<p class="text-sm text-label mb-1.5">Should we text you when all stocks are moving, or only when yours stands out?</p>
										<div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
											<label
												v-for="option in marketContextOptions"
												:key="option.value"
												class="rounded-lg border border-edge bg-surface-alt px-2.5 py-2 text-sm text-label cursor-pointer"
											>
												<input
													v-model="priceAlertMarketContext"
													type="radio"
													name="price_alert_market_context"
													:value="option.value"
													class="h-4 w-4 border-edge-strong text-emerald-600 focus:ring-emerald-500 align-middle"
												/>
												<span class="ml-1.5 align-middle">{{ option.label }}</span>
												<p class="mt-1 text-xs text-muted whitespace-pre-line">{{ option.example }}</p>
											</label>
										</div>
									</div>

									<div :class="activeRetuneStep === 2 ? 'visible' : 'invisible'" :inert="activeRetuneStep !== 2 || undefined">
										<p class="text-sm text-label mb-1.5">How big should a move be before it deserves an alert?</p>
										<div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
											<label
												v-for="option in moveSizeOptions"
												:key="option.value"
												class="rounded-lg border border-edge bg-surface-alt px-2.5 py-2 text-sm text-label cursor-pointer"
											>
												<input
													v-model="priceAlertMoveSize"
													type="radio"
													name="price_alert_move_size"
													:value="option.value"
													class="h-4 w-4 border-edge-strong text-emerald-600 focus:ring-emerald-500 align-middle"
												/>
												<span class="ml-1.5 align-middle">{{ option.label }}</span>
												<p class="mt-1 text-xs text-muted whitespace-pre-line">{{ option.example }}</p>
											</label>
										</div>
									</div>
									<div :class="activeRetuneStep === 3 ? 'visible' : 'invisible'" :inert="activeRetuneStep !== 3 || undefined">
										<p class="text-sm text-label mb-1.5">After your first alert, what should happen?</p>
										<div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
											<label
												v-for="option in followUpOptions"
												:key="option.value"
												class="rounded-lg border border-edge bg-surface-alt px-2.5 py-2 text-sm text-label cursor-pointer"
											>
												<input
													v-model="priceAlertFollowUpMode"
													type="radio"
													name="price_alert_follow_up_mode"
													:value="option.value"
													class="h-4 w-4 border-edge-strong text-emerald-600 focus:ring-emerald-500 align-middle"
												/>
												<span class="ml-1.5 align-middle">{{ option.label }}</span>
												<p class="mt-1 text-xs text-muted whitespace-pre-line">{{ option.example }}</p>
											</label>
										</div>
									</div>
								</div>

								<div class="flex items-center justify-between pt-1">
									<button
										type="button"
										class="rounded-md border border-edge px-2.5 py-1.5 text-xs font-medium text-label transition hover:bg-surface-alt cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
										:disabled="isFirstRetuneStep"
										@click="handleRetunePrevious"
									>
										Back
									</button>
									<p class="text-xs text-muted">
										Question {{ activeRetuneStep + 1 }} of {{ TOTAL_RETUNE_STEPS }}
									</p>
									<button
										type="button"
										class="rounded-md border border-edge bg-surface px-2.5 py-1.5 text-xs font-medium text-label transition hover:bg-surface-alt cursor-pointer"
										@click="handleRetunePrimaryAction"
									>
										{{ retunePrimaryActionLabel }}
									</button>
								</div>
							</div>
						</fieldset>
					</div>
					<div v-else-if="priceAlertsEnabled && !showWizard" key="summary" class="mt-3 border-t border-divider pt-3 pl-3 sm:pl-4">
						<div class="grid grid-cols-2 gap-x-4 gap-y-2.5 text-xs sm:grid-cols-4">
							<div class="flex items-start gap-1.5">
								<span class="text-base leading-none mt-px" aria-hidden="true">🎯</span>
								<div>
									<p class="text-muted">Alert on</p>
									<p class="text-label font-medium">{{ RISK_PRIORITY_LABELS[priceAlertRiskPriority] }}</p>
								</div>
							</div>
							<div class="flex items-start gap-1.5">
								<span class="text-base leading-none mt-px" aria-hidden="true">📊</span>
								<div>
									<p class="text-muted">Market filter</p>
									<p class="text-label font-medium">{{ MARKET_CONTEXT_LABELS[priceAlertMarketContext] }}</p>
								</div>
							</div>
							<div class="flex items-start gap-1.5">
								<span class="text-base leading-none mt-px" aria-hidden="true">📏</span>
								<div>
									<p class="text-muted">Move size</p>
									<p class="text-label font-medium">{{ MOVE_SIZE_LABELS[priceAlertMoveSize] }}</p>
								</div>
							</div>
							<div class="flex items-start gap-1.5">
								<span class="text-base leading-none mt-px" aria-hidden="true">🔁</span>
								<div>
									<p class="text-muted">Same-day follow-up</p>
									<p class="text-label font-medium">{{ FOLLOW_UP_LABELS[priceAlertFollowUpMode] }}</p>
								</div>
							</div>
						</div>
						<button
							type="button"
							class="mt-3 inline-flex items-center gap-1 rounded-md border border-edge px-2.5 py-1 text-xs font-medium text-label transition hover:bg-surface-alt focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500 cursor-pointer"
							@click="startRetune"
						>
							⚙️ Re-tune
						</button>
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
							Scheduled asset price updates for all tracked assets, including ETFs.
						</p>
					</div>
					<div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4 shrink-0">
						<label class="inline-flex items-center gap-1.5 cursor-pointer">
							<input
								type="checkbox"
								v-model="marketIncludeEmail"
								:disabled="notificationSetupBlocked || !emailEnabled"
								class="rounded border-edge-strong text-emerald-600 focus:ring-emerald-500 h-4 w-4 cursor-pointer"
								aria-describedby="market_scheduled_asset_price_enabled_description"
							/>
							<span class="text-sm text-label">Email</span>
						</label>
						<label class="inline-flex items-center gap-1.5" :class="smsReady && !notificationSetupBlocked ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'">
							<input
								type="checkbox"
								v-model="marketIncludeSms"
								:disabled="notificationSetupBlocked || !smsReady"
								class="rounded border-edge-strong text-emerald-600 focus:ring-emerald-500 h-4 w-4 cursor-pointer"
								aria-describedby="market_scheduled_asset_price_enabled_description"
							/>
							<span class="text-sm text-label">SMS</span>
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
								<span>No scheduled asset price notification delivery times selected.</span>
							</p>
						</FadeTransition>

						<ScheduledUpdateControls
							:scheduledUpdateTimes="scheduledUpdateTimes"
							:needsChannelSelection="notificationSetupBlocked"
							:timePickerDisabled="timePickerDisabled"
							:canAddTime="canAddTime"
							:canAddMarketOpen="canAddMarketOpen"
							:marketOpenLabel="marketOpenLabel"
							:maxTimes="MAX_DELIVERY_TIMES"
							:maxTimesReached="maxTimesReached"
							:countdownText="countdownText"
							:countdownDelayReasons="countdownDelayReasons"
							:countdownHolidayName="countdownHolidayName"
							:outsideMarketHoursIndices="outsideMarketHoursIndices"
							:is24="is24"
							@time-change="handleTimeChange"
							@add-time="handleAddTime"
							@add-initial-time="handleAddInitialTime"
							@add-market-open="handleAddMarketOpen"
							@remove-time="handleRemoveTime"
						/>
					</div>
				</FadeTransition>
			</div>

			</fieldset>
			</div>
		</section>
	</form>

</template>

<script lang="ts" setup>
import { computed, ref, toRefs, watch } from "vue";
// ?component suffix required: Astro Icon cannot be used in Vue; vite-svg-loader compiles this to a Vue component.
import ArrowPathIcon from "../../../icons/arrow-path.svg?component";
import GrokLogoDarkIcon from "../../../icons/grok-dark.svg?component";
import GrokLogoLightIcon from "../../../icons/grok-light.svg?component";
import InformationCircleIcon from "../../../icons/information-circle-20.svg?component";
import MassiveLogoIcon from "../../../icons/massive.svg?component";
import {
	CARD_GRADIENT_ACCENTS,
	DASHBOARD_MARKET_FORM_ID,
	DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID,
	DASHBOARD_SECTION_IDS,
	DEFAULT_MARKET_UPDATE_TIME_MINUTES,
	STATUS_TONE_CLASSES,
} from "../../../lib/constants";
import type {
	AlertFollowUpMode,
	AlertMarketContext,
	AlertMoveSize,
	AlertRiskPriority,
} from "../../../lib/market-notifications/alert-profile";
import {
	formatMinutesAsLocalTime,
	getUsMarketOpenLocalMinutes,
	isOutsideMarketHours,
	minutesToTimeInputValue,
	parseTimeToMinutes,
} from "../../../lib/time/format";
import FadeTransition from "../../FadeTransition.vue";
import type { InitialAsset } from "../assets/types";
import {
	type NotificationPreferencesData,
	useAutoSaveForm,
} from "../composables/useAutoSaveNotificationPreferences";
import { useDashboardUser } from "../composables/useDashboardUser";
import SetupRequiredNotice from "../shared/SetupRequiredNotice.vue";
import { useScheduledUpdateTiming } from "./helpers";
import ScheduledUpdateControls from "./ScheduledUpdateControls.vue";
import { useOnboardingExamples } from "./useOnboardingExamples";

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
const priceAlertOnboardingCompleted = ref(
	user.value.market_asset_price_alert_onboarding_completed ?? false,
);
const priceAlertRiskPriority = ref<AlertRiskPriority>(
	user.value.market_asset_price_alert_risk_priority ?? "both_equally",
);
function normalizeMarketContext(
	value: AlertMarketContext | null | undefined,
): AlertMarketContext {
	if (value === "any_major" || value === "extreme_only") return value;
	return "standout";
}
const priceAlertMarketContext = ref<AlertMarketContext>(
	normalizeMarketContext(user.value.market_asset_price_alert_market_context),
);
const priceAlertMoveSize = ref<AlertMoveSize>(
	user.value.market_asset_price_alert_move_size ?? "large",
);
const priceAlertFollowUpMode = ref<AlertFollowUpMode>(
	user.value.market_asset_price_alert_follow_up_mode ?? "first_only",
);

// Composable fetches prices lazily when the wizard is visible
const wizardVisible = computed(() => priceAlertsEnabled.value);
const {
	riskPriorityOptions,
	marketContextOptions,
	moveSizeOptions,
	followUpOptions,
} = useOnboardingExamples(trackedAssets, wizardVisible);

const TOTAL_RETUNE_STEPS = 4;
const activeRetuneStep = ref(0);
const isFirstRetuneStep = computed(() => activeRetuneStep.value === 0);
const isLastRetuneStep = computed(
	() => activeRetuneStep.value === TOTAL_RETUNE_STEPS - 1,
);
const showFinishSetupButton = computed(
	() => !priceAlertOnboardingCompleted.value && isLastRetuneStep.value,
);
const retuning = ref(false);
const showWizard = computed(
	() => !priceAlertOnboardingCompleted.value || retuning.value,
);
const isPriceAlertAutosaveLocked = computed(
	() => !priceAlertOnboardingCompleted.value,
);
const retunePrimaryActionLabel = computed(() => {
	if (showFinishSetupButton.value) return "Finish setup";
	if (retuning.value && isLastRetuneStep.value) return "Save";
	return "Next";
});

const RISK_PRIORITY_LABELS: Record<AlertRiskPriority, string> = {
	big_drops: "Big drops only",
	big_gains: "Big gains only",
	both_equally: "Drops and gains",
};
const MARKET_CONTEXT_LABELS: Record<AlertMarketContext, string> = {
	any_major: "Any big move",
	standout: "Standouts only",
	extreme_only: "Extreme outliers",
};
const MOVE_SIZE_LABELS: Record<AlertMoveSize, string> = {
	moderate: "Moderate (\u22653% or $5)",
	large: "Large (\u22655% or $10)",
	very_large: "Very large (\u22658% or $20)",
};
const FOLLOW_UP_LABELS: Record<AlertFollowUpMode, string> = {
	first_only: "None",
	allow_acceleration_follow_up: "If move accelerates",
	allow_recovery_follow_up: "If move reverses",
};

const MAX_SCHEDULED_UPDATE_MINUTES = 23 * 60 + 59;
const SCHEDULED_UPDATE_INCREMENT_MINUTES = 1;
const MAX_DELIVERY_TIMES = 5;
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
const smsReady = computed(
	() => phoneVerified.value && !smsOptedOut.value,
);
const hasNotificationChannel = computed(
	() =>
		emailEnabled.value ||
		(user.value.market_scheduled_asset_price_include_sms ||
			user.value.market_asset_price_alerts_include_sms) &&
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
			user.value.market_asset_price_alerts_include_sms) &&
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

const marketOpenLocalMinutes = computed(() => {
	const tz = timezone.value;
	if (tz === "") return null;
	return getUsMarketOpenLocalMinutes(tz);
});

const marketOpenLabel = computed(() => {
	if (marketOpenLocalMinutes.value === null) return null;
	return formatMinutesAsLocalTime(marketOpenLocalMinutes.value, user.value.use_24_hour_time);
});

const hasMarketOpenTime = computed(() => {
	if (marketOpenLocalMinutes.value === null) return true;
	return scheduledUpdateTimesMinutes.value.includes(marketOpenLocalMinutes.value);
});

const canAddMarketOpen = computed(
	() => !timePickerDisabled.value && !hasMarketOpenTime.value && !maxTimesReached.value,
);

const outsideMarketHoursIndices = computed<Set<number>>(() => {
	const tz = timezone.value;
	if (tz === "") return new Set();
	const indices = new Set<number>();
	for (let i = 0; i < scheduledUpdateTimesMinutes.value.length; i++) {
		if (isOutsideMarketHours(scheduledUpdateTimesMinutes.value[i], tz)) {
			indices.add(i);
		}
	}
	return indices;
});

watch(
	() => user.value.market_scheduled_asset_price_include_email,
	(value) => {
		marketIncludeEmail.value = value;
	},
);
watch(
	() => user.value.market_scheduled_asset_price_include_sms,
	(value) => {
		marketIncludeSms.value = value;
	},
);
watch(
	() => user.value.market_asset_price_alerts_include_email,
	(value) => {
		priceAlertsIncludeEmail.value = value;
	},
);
watch(
	() => user.value.market_asset_price_alerts_include_sms,
	(value) => {
		priceAlertsIncludeSms.value = value;
	},
);
watch(
	() => user.value.market_asset_price_alert_onboarding_completed,
	(value) => {
		priceAlertOnboardingCompleted.value = value ?? false;
	},
);
watch(
	() => user.value.market_asset_price_alert_risk_priority,
	(value) => {
		priceAlertRiskPriority.value = value ?? "both_equally";
	},
);
watch(
	() => user.value.market_asset_price_alert_market_context,
	(value) => {
		priceAlertMarketContext.value = normalizeMarketContext(value);
	},
);
watch(
	() => user.value.market_asset_price_alert_move_size,
	(value) => {
		priceAlertMoveSize.value = value ?? "large";
	},
);
watch(
	() => user.value.market_asset_price_alert_follow_up_mode,
	(value) => {
		priceAlertFollowUpMode.value = value ?? "first_only";
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
			...(newData.market_asset_price_alert_onboarding_completed !== undefined && {
				market_asset_price_alert_onboarding_completed: newData.market_asset_price_alert_onboarding_completed,
			}),
			...(newData.market_asset_price_alert_risk_priority !== undefined && {
				market_asset_price_alert_risk_priority: newData.market_asset_price_alert_risk_priority,
			}),
			...(newData.market_asset_price_alert_market_context !== undefined && {
				market_asset_price_alert_market_context: newData.market_asset_price_alert_market_context,
			}),
			...(newData.market_asset_price_alert_move_size !== undefined && {
				market_asset_price_alert_move_size: newData.market_asset_price_alert_move_size,
			}),
			...(newData.market_asset_price_alert_follow_up_mode !== undefined && {
				market_asset_price_alert_follow_up_mode: newData.market_asset_price_alert_follow_up_mode,
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

watch([priceAlertRiskPriority, priceAlertMarketContext, priceAlertMoveSize, priceAlertFollowUpMode], ([riskPriority, marketContext, moveSize, followUpMode]) => {
	if (!priceAlertOnboardingCompleted.value) {
		return;
	}
	if (
		riskPriority === (user.value.market_asset_price_alert_risk_priority ?? "both_equally") &&
		marketContext === (user.value.market_asset_price_alert_market_context ?? "standout") &&
		moveSize === (user.value.market_asset_price_alert_move_size ?? "large") &&
		followUpMode === (user.value.market_asset_price_alert_follow_up_mode ?? "first_only")
	) {
		return;
	}
	user.value = {
		...user.value,
		market_asset_price_alert_risk_priority: riskPriority,
		market_asset_price_alert_market_context: marketContext,
		market_asset_price_alert_move_size: moveSize,
		market_asset_price_alert_follow_up_mode: followUpMode,
	};
	notifyChange();
});

watch(priceAlertOnboardingCompleted, (value) => {
	if (value === (user.value.market_asset_price_alert_onboarding_completed ?? false)) {
		return;
	}
	user.value = {
		...user.value,
		market_asset_price_alert_onboarding_completed: value,
	};
	notifyChange();
});

watch([priceAlertsIncludeEmail, priceAlertsIncludeSms], ([email, sms]) => {
	if (!priceAlertOnboardingCompleted.value) {
		return;
	}
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

function handleRetunePrevious() {
	if (isFirstRetuneStep.value) return;
	activeRetuneStep.value -= 1;
}

function handleRetuneNext() {
	if (isLastRetuneStep.value) return;
	activeRetuneStep.value += 1;
}

function startRetune() {
	activeRetuneStep.value = 0;
	retuning.value = true;
}

function handleRetunePrimaryAction() {
	if (showFinishSetupButton.value) {
		user.value = {
			...user.value,
			market_asset_price_alerts_include_email: priceAlertsIncludeEmail.value,
			market_asset_price_alerts_include_sms: priceAlertsIncludeSms.value,
			market_asset_price_alerts_enabled:
				priceAlertsIncludeEmail.value || priceAlertsIncludeSms.value,
			market_asset_price_alert_risk_priority: priceAlertRiskPriority.value,
			market_asset_price_alert_market_context: priceAlertMarketContext.value,
			market_asset_price_alert_move_size: priceAlertMoveSize.value,
			market_asset_price_alert_follow_up_mode: priceAlertFollowUpMode.value,
			market_asset_price_alert_onboarding_completed: true,
		};
		priceAlertOnboardingCompleted.value = true;
		retuning.value = false;
		notifyChange();
		return;
	}
	if (retuning.value && isLastRetuneStep.value) {
		retuning.value = false;
		notifyChange();
		return;
	}
	handleRetuneNext();
}

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
	// When empty, use market open as the first suggested time (falls back to 9:00 AM)
	if (times.length === 0) {
		scheduledUpdateTimesMinutes.value = [marketOpenLocalMinutes.value ?? DEFAULT_MARKET_UPDATE_TIME_MINUTES];
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

function handleAddMarketOpen() {
	if (!canAddMarketOpen.value || marketOpenLocalMinutes.value === null) {
		return;
	}
	const times = normalizeScheduledTimes(scheduledUpdateTimesMinutes.value);
	const baseTimes =
		times.length === 0 ? [marketOpenLocalMinutes.value] : [...times, marketOpenLocalMinutes.value];
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
