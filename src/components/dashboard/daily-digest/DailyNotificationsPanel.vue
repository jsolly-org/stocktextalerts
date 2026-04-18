<template>
	<form
		ref="extrasFormElement"
		:id="DASHBOARD_DAILY_NOTIFICATIONS_FORM_ID"
		method="POST"
		action="/api/notification-preferences/update"
		aria-label="Daily Digest"
		:aria-busy="isSaving"
		@input="handleFormInput"
		@change="handleFormChange"
		@submit="handleFormSubmit"
	>
		<input
			v-if="shouldSubmitDailyDigestTime"
			type="hidden"
			name="daily_digest_time"
			:value="dailyDigestTimeInputForSubmit ?? ''"
		/>
		<section class="card relative">
			<FormStatusBadge
				:status-message="statusMessage"
				:status-tone="statusTone"
				:is-saving="isSaving"
			/>

			<div :class="`card-accent ${CARD_GRADIENT_ACCENTS.teal}`"></div>
			<div class="card-body">
			<header class="mb-4">
				<h2
					:id="DASHBOARD_SECTION_IDS.dailyNotifications"
					class="text-xl sm:text-2xl font-bold text-heading"
				>
					Daily Digest
				</h2>
			<p
				class="text-sm text-body-secondary mt-1"
			>
				Everything you enable below is bundled into <strong class="font-semibold text-label">one daily message</strong> sent at your daily digest <a href="#daily_digest_time" class="font-medium text-primary underline rounded-sm hover:text-primary-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1">delivery time</a>.
			</p>
			</header>

		<SetupRequiredNotice
			:needsTrackedAssets="needsTrackedAssets"
			:needsChannelSelection="needsChannelSelection"
			:needsPhoneVerification="needsPhoneVerification"
			:phoneVerificationSectionId="phoneVerificationSectionId"
		/>

	<fieldset
			class="divide-y divide-divider transition-opacity duration-200"
				:class="{ 'opacity-50': notificationSetupBlocked }"
				:aria-disabled="notificationSetupBlocked ? 'true' : undefined"
			>
					<legend class="sr-only">Daily digest settings</legend>

				<div class="flex items-center justify-between gap-3 py-3">
					<input
						type="hidden"
					name="daily_digest_include_prices_email"
					:value="includePricesEmail ? 'on' : 'off'"
				/>
					<input
						type="hidden"
					name="daily_digest_include_prices_sms"
					:value="includePricesSms ? 'on' : 'off'"
				/>
				<div class="min-w-0">
					<div class="flex items-center gap-2">
						<span
							id="daily_digest_include_prices_label"
								class="text-base font-semibold text-heading"
							>
								💰 Asset Prices
							</span>
						</div>
						<p
							id="daily_digest_include_prices_description"
							class="text-sm text-body-secondary mt-0.5"
						>
							Include current prices and change percentages for your tracked assets.
						</p>
					</div>
				<div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4 shrink-0">
					<label
						class="inline-flex items-center gap-1.5"
						:class="emailOnlyDisabled ? 'cursor-not-allowed' : 'cursor-pointer'"
						:title="emailDisabledTitle"
					>
						<input
							type="checkbox"
							v-model="includePricesEmail"
							:disabled="emailOnlyDisabled"
							class="rounded border-edge-strong text-teal-600 focus:ring-teal-500 h-4 w-4"
							:class="emailOnlyDisabled ? 'cursor-not-allowed' : 'cursor-pointer'"
							aria-label="Asset Prices Email"
							aria-describedby="daily_digest_include_prices_description"
						/>
						<span class="text-sm text-label">Email</span>
					</label>
					<label
						class="inline-flex items-center gap-1.5"
						:class="smsReady && !notificationSetupBlocked ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'"
						:title="smsDisabledTitle"
					>
						<input
							type="checkbox"
							v-model="includePricesSms"
							:disabled="notificationSetupBlocked || !smsReady"
							class="rounded border-edge-strong text-teal-600 focus:ring-teal-500 h-4 w-4"
							:class="smsReady && !notificationSetupBlocked ? 'cursor-pointer' : 'cursor-not-allowed'"
							aria-label="Asset Prices SMS"
							aria-describedby="daily_digest_include_prices_description"
						/>
						<span class="text-sm text-label">SMS</span>
					</label>
				</div>
				</div>

				<div class="flex items-center justify-between gap-3 py-3">
					<input
						type="hidden"
						name="daily_digest_include_top_movers_email"
						:value="includeTopMoversEmail ? 'on' : 'off'"
					/>
					<input
						type="hidden"
						name="daily_digest_include_top_movers_sms"
						:value="includeTopMoversSms ? 'on' : 'off'"
					/>
					<div class="min-w-0">
						<div class="flex items-center gap-2">
							<span
								id="daily_digest_include_top_movers_label"
								class="text-base font-semibold text-heading"
							>
								🚀 Top Movers
							</span>
							<MassiveLogoIcon class="h-4.5 w-auto shrink-0" aria-label="Powered by Massive" role="img" />
						</div>
						<p
							id="daily_digest_include_top_movers_description"
							class="text-sm text-body-secondary mt-0.5"
						>
							Include the day's biggest market-wide gainers and losers (US stocks priced $5+).
						</p>
					</div>
					<div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4 shrink-0">
						<label
							class="inline-flex items-center gap-1.5"
							:class="emailOnlyDisabled ? 'cursor-not-allowed' : 'cursor-pointer'"
							:title="emailDisabledTitle"
						>
							<input
								type="checkbox"
								v-model="includeTopMoversEmail"
								:disabled="emailOnlyDisabled"
								class="rounded border-edge-strong text-teal-600 focus:ring-teal-500 h-4 w-4"
								:class="emailOnlyDisabled ? 'cursor-not-allowed' : 'cursor-pointer'"
								aria-label="Top Movers Email"
								aria-describedby="daily_digest_include_top_movers_description"
							/>
							<span class="text-sm text-label">Email</span>
						</label>
						<label
							class="inline-flex items-center gap-1.5"
							:class="smsReady && !notificationSetupBlocked ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'"
							:title="smsDisabledTitle"
						>
							<input
								type="checkbox"
								v-model="includeTopMoversSms"
								:disabled="notificationSetupBlocked || !smsReady"
								class="rounded border-edge-strong text-teal-600 focus:ring-teal-500 h-4 w-4"
								:class="smsReady && !notificationSetupBlocked ? 'cursor-pointer' : 'cursor-not-allowed'"
								aria-label="Top Movers SMS"
								aria-describedby="daily_digest_include_top_movers_description"
							/>
							<span class="text-sm text-label">SMS</span>
						</label>
					</div>
				</div>

				<div class="flex items-center justify-between gap-3 py-3">
					<input
						type="hidden"
						name="daily_digest_include_news_email"
						:value="includeNewsEmail ? 'on' : 'off'"
					/>
					<div class="min-w-0">
						<div class="flex items-center gap-2">
							<span
								id="daily_digest_include_news_label"
								class="text-base font-semibold text-heading"
							>
								🗞️ News
							</span>
							<GrokLogoLightIcon class="h-4.5 w-auto shrink-0 dark:hidden" aria-label="Powered by Grok" role="img" />
							<GrokLogoDarkIcon class="hidden h-4.5 w-auto shrink-0 dark:inline" aria-label="Powered by Grok" role="img" />
							<MassiveLogoIcon class="h-4.5 w-auto shrink-0" aria-label="Powered by Massive" role="img" />
						</div>
						<p
							id="daily_digest_include_news_description"
							class="text-sm text-body-secondary mt-0.5"
						>
							Add a short news summary about the assets you're tracking.
						</p>
					</div>
					<div class="shrink-0">
						<label
							class="inline-flex items-center gap-1.5"
							:class="emailOnlyDisabled ? 'cursor-not-allowed' : 'cursor-pointer'"
							:title="emailDisabledTitle"
						>
							<input
								type="checkbox"
								v-model="includeNewsEmail"
								:disabled="emailOnlyDisabled"
								class="rounded border-edge-strong text-teal-600 focus:ring-teal-500 h-4 w-4"
								:class="emailOnlyDisabled ? 'cursor-not-allowed' : 'cursor-pointer'"
								aria-label="News Email"
								aria-describedby="daily_digest_include_news_description"
							/>
							<span class="text-sm text-label">Email</span>
						</label>
					</div>
				</div>

				<div class="flex items-center justify-between gap-3 py-3">
					<input
						type="hidden"
					name="daily_digest_include_rumors_email"
					:value="includeRumorsEmail ? 'on' : 'off'"
				/>
				<div class="min-w-0">
					<div class="flex items-center gap-2">
						<span
							id="daily_digest_include_rumors_label"
								class="text-base font-semibold text-heading"
							>
								🤫 Rumors
							</span>
							<GrokLogoLightIcon class="h-4.5 w-auto shrink-0 dark:hidden" aria-label="Powered by Grok" role="img" />
							<GrokLogoDarkIcon class="hidden h-4.5 w-auto shrink-0 dark:inline" aria-label="Powered by Grok" role="img" />
					</div>
						<p
							id="daily_digest_include_rumors_description"
							class="text-sm text-body-secondary mt-0.5"
						>
							Add a short rumors/chatter summary about the assets you're tracking.
						</p>
					</div>
				<div class="shrink-0">
					<label
						class="inline-flex items-center gap-1.5"
						:class="emailOnlyDisabled ? 'cursor-not-allowed' : 'cursor-pointer'"
						:title="emailDisabledTitle"
					>
						<input
							type="checkbox"
							v-model="includeRumorsEmail"
							:disabled="emailOnlyDisabled"
							class="rounded border-edge-strong text-teal-600 focus:ring-teal-500 h-4 w-4"
							:class="emailOnlyDisabled ? 'cursor-not-allowed' : 'cursor-pointer'"
							aria-label="Rumors Email"
							aria-describedby="daily_digest_include_rumors_description"
						/>
						<span class="text-sm text-label">Email</span>
					</label>
				</div>
				</div>

				</fieldset>

				<div v-if="isHydrated && nextDailyDeliveryText" class="mt-4 border-t border-edge pt-4">
					<p class="inline-flex items-center gap-2 text-sm text-body-secondary">
						<BellAlertIcon class="size-4 shrink-0 text-success-strong" aria-hidden="true" />
						<span>Next delivery <span class="font-medium text-heading">{{ nextDailyDeliveryText }}</span>.</span>
					</p>
				</div>
			</div>
		</section>
	</form>
</template>

<script lang="ts" setup>
import { DateTime } from "luxon";
import { computed, onMounted, onUnmounted, ref, toRefs, watch } from "vue";
// ?component suffix required: Astro Icon cannot be used in Vue; vite-svg-loader compiles this to a Vue component.
import BellAlertIcon from "../../../icons/bell-alert.svg?component";
import GrokLogoDarkIcon from "../../../icons/grok-dark.svg?component";
import GrokLogoLightIcon from "../../../icons/grok-light.svg?component";
import MassiveLogoIcon from "../../../icons/massive.svg?component";
import {
	CARD_GRADIENT_ACCENTS,
	DASHBOARD_DAILY_NOTIFICATIONS_FORM_ID,
	DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID,
	DASHBOARD_SECTION_IDS,
} from "../../../lib/constants";
import {
	formatCountdownWithSeconds,
	getSecondsUntilNextSend,
	minutesToTimeInputValue,
} from "../../../lib/time/format";
import {
	type NotificationPreferencesData,
	useAutoSaveForm,
} from "../composables/useAutoSaveNotificationPreferences";
import { useDashboardUser } from "../composables/useDashboardUser";
import {
	getEmailChannelDisabledTitle,
	getSmsChannelDisabledTitle,
} from "../shared/channel-disabled-titles";
import FormStatusBadge from "../shared/FormStatusBadge.vue";
import SetupRequiredNotice from "../shared/SetupRequiredNotice.vue";

interface Props {
	emailEnabled: boolean;
	phoneVerified: boolean;
	hasTrackedAssets: boolean;
}

const props = defineProps<Props>();
const { emailEnabled, phoneVerified, hasTrackedAssets } =
	toRefs(props);

const user = useDashboardUser();

const smsOptedOut = computed(() => user.value.sms_opted_out === true);
const smsNotificationsEnabled = computed(() => user.value.sms_notifications_enabled === true);
const smsReady = computed(
	() => phoneVerified.value && !smsOptedOut.value && smsNotificationsEnabled.value,
);
const hasAnySmsFeatureEnabled = computed(
	() =>
		user.value.daily_digest_include_prices_sms ||
		user.value.daily_digest_include_top_movers_sms ||
		user.value.market_scheduled_asset_price_include_sms ||
		user.value.asset_events_include_calendar_sms ||
		user.value.asset_events_include_ipo_sms ||
		user.value.asset_events_include_analyst_sms ||
		user.value.asset_events_include_insider_sms ||
		user.value.market_asset_price_alerts_include_sms,
);
const hasNotificationChannel = computed(
	() => emailEnabled.value || (smsReady.value && hasAnySmsFeatureEnabled.value),
);
const needsChannelSelection = computed(() => !hasNotificationChannel.value);
const needsTrackedAssets = computed(() => !hasTrackedAssets.value);
const notificationSetupBlocked = computed(
	() => needsChannelSelection.value || needsTrackedAssets.value,
);
const needsPhoneVerification = computed(
	() => hasAnySmsFeatureEnabled.value && !phoneVerified.value,
);

/** News & Rumors are email-only — disable when email channel isn't enabled */
const emailOnlyDisabled = computed(
	() => notificationSetupBlocked.value || !emailEnabled.value,
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
const phoneVerificationSectionId = `${DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID}-phone-verification-section`;

const isHydrated = ref(false);
const tick = ref(0);
let intervalId: number | null = null;

onMounted(() => {
	isHydrated.value = true;
	tick.value = Date.now();
	intervalId = window.setInterval(() => {
		tick.value = Date.now();
	}, 1000);
});
onUnmounted(() => {
	if (intervalId === null) return;
	window.clearInterval(intervalId);
	intervalId = null;
});

const extrasFormElement = ref<HTMLFormElement | null>(null);
const {
	handleFormChange,
	handleFormInput,
	handleFormSubmit,
	isSaving,
	notifyChange,
	savedData,
	statusMessage,
	statusTone,
} = useAutoSaveForm<NotificationPreferencesData>({
	formRef: extrasFormElement,
});

const includePricesEmail = ref(user.value.daily_digest_include_prices_email);
const includePricesSms = ref(user.value.daily_digest_include_prices_sms);
const includeTopMoversEmail = ref(
	user.value.daily_digest_include_top_movers_email,
);
const includeTopMoversSms = ref(
	user.value.daily_digest_include_top_movers_sms,
);
const includeNewsEmail = ref(user.value.daily_digest_include_news_email);
const includeRumorsEmail = ref(user.value.daily_digest_include_rumors_email);

const dailyEnabled = computed(() =>
	includePricesEmail.value ||
	includePricesSms.value ||
	includeTopMoversEmail.value ||
	includeTopMoversSms.value ||
	includeNewsEmail.value ||
	includeRumorsEmail.value,
);

const hasAnyAssetEventsOptionEnabled = computed(
	() =>
		user.value.asset_events_include_calendar_email ||
		user.value.asset_events_include_calendar_sms ||
		user.value.asset_events_include_ipo_email ||
		user.value.asset_events_include_ipo_sms ||
		user.value.asset_events_include_analyst_email ||
		user.value.asset_events_include_analyst_sms ||
		user.value.asset_events_include_insider_email ||
		user.value.asset_events_include_insider_sms,
);

/** Derive the current delivery time input from the shared user state (managed by NotificationChannelsPanel). */
const dailyDeliveryTimeInput = computed(() => {
	const minutes = user.value.daily_digest_time;
	return minutes !== null && minutes !== undefined
		? minutesToTimeInputValue(minutes)
		: null;
});

function getEarliestMarketNotificationTime(): number | null {
	const times = user.value.market_scheduled_asset_price_times;
	if (!times || times.length === 0) return null;
	return Math.min(...times);
}

/**
 * Ensure daily-digest saves include a delivery time even when the Alerts panel
 * hasn't mounted yet (mobile lazy tabs).
 */
const lastKnownDailyDeliveryTimeInput = ref<string | null>(null);
watch(
	dailyDeliveryTimeInput,
	(value) => {
		if (value !== null) lastKnownDailyDeliveryTimeInput.value = value;
	},
	{ immediate: true },
);

const dailyDigestTimeInputForSubmit = computed(() => {
	if (dailyDeliveryTimeInput.value !== null) return dailyDeliveryTimeInput.value;
	if (!dailyEnabled.value) {
		// When daily is disabled but asset events are enabled, keep submitting the
		// prior delivery time so this form doesn't accidentally clear
		// `daily_digest_time` (asset-events scheduling uses it as a fallback).
		return hasAnyAssetEventsOptionEnabled.value
			? lastKnownDailyDeliveryTimeInput.value
			: null;
	}
	const fallbackMinutes = getEarliestMarketNotificationTime();
	return fallbackMinutes !== null
		? minutesToTimeInputValue(fallbackMinutes)
		: null;
});

const shouldClearDailyDigestTimeOnSubmit = computed(
	() => !dailyEnabled.value && !hasAnyAssetEventsOptionEnabled.value,
);
const shouldSubmitDailyDigestTime = computed(
	() =>
		dailyEnabled.value ||
		dailyDigestTimeInputForSubmit.value !== null ||
		shouldClearDailyDigestTimeOnSubmit.value,
);

const nextDailyDeliveryText = computed(() => {
	if (!isHydrated.value || !dailyEnabled.value) return null;
	void tick.value;

	if (!user.value.timezone) return null;

	const secondsUntil = getSecondsUntilNextSend({
		nextSendAtIso: user.value.daily_digest_next_send_at,
		timeInput: dailyDeliveryTimeInput.value,
		timezone: user.value.timezone,
		now: DateTime.utc(),
	});
	if (secondsUntil === null) return null;
	return secondsUntil <= 0 ? "is due soon" : `in ${formatCountdownWithSeconds(secondsUntil)}`;
});

watch(
	[
		includePricesEmail,
		includePricesSms,
		includeTopMoversEmail,
		includeTopMoversSms,
		includeNewsEmail,
		includeRumorsEmail,
	],
	() => {
		notifyChange();
	},
);

watch(
	() => user.value.daily_digest_include_prices_email,
	(value) => {
		includePricesEmail.value = value;
	},
);
watch(
	() => user.value.daily_digest_include_prices_sms,
	(value) => {
		includePricesSms.value = value;
	},
);
watch(
	() => user.value.daily_digest_include_top_movers_email,
	(value) => {
		includeTopMoversEmail.value = value;
	},
);
watch(
	() => user.value.daily_digest_include_top_movers_sms,
	(value) => {
		includeTopMoversSms.value = value;
	},
);
watch(
	() => user.value.daily_digest_include_news_email,
	(value) => {
		includeNewsEmail.value = value;
	},
);
watch(
	() => user.value.daily_digest_include_rumors_email,
	(value) => {
		includeRumorsEmail.value = value;
	},
);

/* =============
Keep dashboard user state aligned with autosave responses
============= */
watch(savedData, (newData) => {
	if (!newData) return;
	user.value = {
		...user.value,
		daily_digest_include_prices_email: newData.daily_digest_include_prices_email,
		daily_digest_include_prices_sms: newData.daily_digest_include_prices_sms,
		daily_digest_include_top_movers_email:
			newData.daily_digest_include_top_movers_email,
		daily_digest_include_top_movers_sms:
			newData.daily_digest_include_top_movers_sms,
		daily_digest_include_news_email: newData.daily_digest_include_news_email,
		daily_digest_include_rumors_email: newData.daily_digest_include_rumors_email,
		daily_digest_time: newData.daily_digest_time,
		daily_digest_next_send_at: newData.daily_digest_next_send_at,
		// Daily delivery time determines asset events delivery time, so the server
		// recalculates asset_events_next_send_at when it changes. Keep all panels'
		// scheduling in sync so countdowns update without a page refresh.
		asset_events_next_send_at: newData.asset_events_next_send_at,
		market_scheduled_asset_price_next_send_at: newData.market_scheduled_asset_price_next_send_at,
	};
});
</script>
