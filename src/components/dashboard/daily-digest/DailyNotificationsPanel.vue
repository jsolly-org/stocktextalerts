<template>
	<form
		ref="extrasFormElement"
		:id="DASHBOARD_DAILY_NOTIFICATIONS_FORM_ID"
		method="POST"
		action="/api/notification-preferences/update"
		aria-label="Daily Notification"
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

			<div class="card-accent card-accent-teal"></div>
			<div class="card-body">
			<header class="mb-4">
				<h2
					:id="DASHBOARD_SECTION_IDS.dailyNotifications"
					class="text-xl sm:text-2xl font-bold text-heading"
				>
					Daily Notification
				</h2>
			<p
				class="text-sm text-body-secondary mt-1"
			>
				Everything you enable below is bundled into <strong class="font-semibold text-label">one daily message</strong> sent at your <a href="#daily_digest_time" class="font-medium text-primary underline rounded-sm hover:text-primary-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1">daily notification delivery time</a>.
			</p>
			</header>

		<SetupRequiredNotice
			:needs-tracked-assets="needsTrackedAssets"
			:needs-channel-selection="needsChannelSelection"
			:needs-phone-verification="needsPhoneVerification"
			:phone-verification-section-id="phoneVerificationSectionId"
		/>

	<fieldset
			class="divide-y divide-divider transition-opacity duration-200"
				:class="{ 'opacity-50': notificationSetupBlocked }"
				:aria-disabled="notificationSetupBlocked ? 'true' : undefined"
			>
					<legend class="sr-only">Daily notification settings</legend>

				<div class="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
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
					<input
						type="hidden"
					name="daily_digest_include_prices_telegram"
					:value="includePricesTelegram ? 'on' : 'off'"
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
				<div class="shrink-0">
					<ChannelMultiSelect
						id-prefix="daily_digest_include_prices"
						labelledby="daily_digest_include_prices_label"
						:options="pricesChannelOptions"
						@toggle="handlePricesToggle"
					/>
				</div>
				</div>

				<div class="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
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
					<input
						type="hidden"
						name="daily_digest_include_top_movers_telegram"
						:value="includeTopMoversTelegram ? 'on' : 'off'"
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
					<div class="shrink-0">
						<ChannelMultiSelect
							id-prefix="daily_digest_include_top_movers"
							labelledby="daily_digest_include_top_movers_label"
							:options="topMoversChannelOptions"
							@toggle="handleTopMoversToggle"
						/>
					</div>
				</div>

				<div class="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
					<input
						type="hidden"
						name="daily_digest_include_news_email"
						:value="includeNewsEmail ? 'on' : 'off'"
					/>
					<input
						type="hidden"
						name="daily_digest_include_news_telegram"
						:value="includeNewsTelegram ? 'on' : 'off'"
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
						<ChannelMultiSelect
							id-prefix="daily_digest_include_news"
							labelledby="daily_digest_include_news_label"
							:options="newsChannelOptions"
							@toggle="handleNewsToggle"
						/>
					</div>
				</div>

				<div class="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
					<input
						type="hidden"
					name="daily_digest_include_rumors_email"
					:value="includeRumorsEmail ? 'on' : 'off'"
				/>
					<input
						type="hidden"
					name="daily_digest_include_rumors_telegram"
					:value="includeRumorsTelegram ? 'on' : 'off'"
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
					<ChannelMultiSelect
						id-prefix="daily_digest_include_rumors"
						labelledby="daily_digest_include_rumors_label"
						:options="rumorsChannelOptions"
						@toggle="handleRumorsToggle"
					/>
				</div>
				</div>

				<DailyAssetEventsFieldset
					:email-enabled="emailEnabled"
					:phone-verified="phoneVerified"
					:has-tracked-assets="hasTrackedAssets"
					:needs-channel-selection="needsChannelSelection"
					:notification-setup-blocked="notificationSetupBlocked"
					:telegram-prefs="assetEventTelegramPrefs"
					:notify-change="notifyChange"
				/>

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
import { DASHBOARD_SECTION_IDS } from "../../../lib/constants";
import { etMinuteToUserLocal } from "../../../lib/time/conversion";
import {
	formatCountdownWithSeconds,
	getSecondsUntilNextSend,
	minutesToTimeInputValue,
} from "../../../lib/time/display";
import { useHydrated } from "../../useHydrated";
import { useAutoSaveForm } from "../composables/useAutoSaveNotificationPreferences";
import { useDashboardUser } from "../composables/useDashboardUser";
import {
	DASHBOARD_DAILY_NOTIFICATIONS_FORM_ID,
	DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID,
} from "../constants";
import ChannelMultiSelect from "../shared/ChannelMultiSelect.vue";
import {
	getEmailChannelDisabledTitle,
	getSmsChannelDisabledTitle,
} from "../shared/channel-disabled-titles";
import { createChannelOptionBuilders } from "../shared/channel-options";
import FormStatusBadge from "../shared/FormStatusBadge.vue";
import SetupRequiredNotice from "../shared/SetupRequiredNotice.vue";
import type { ChannelOption, NotificationPreferencesData } from "../types";
import DailyAssetEventsFieldset from "./DailyAssetEventsFieldset.vue";

interface Props {
	emailEnabled: boolean;
	phoneVerified: boolean;
	hasTrackedAssets: boolean;
	/**
	 * The user's current daily-digest Telegram selections, keyed by content facet
	 * ("prices" | "top_movers" | "news" | "rumors"). Loaded server-side from
	 * `notification_preferences` (channel='telegram'); absent facets default to off.
	 * The autosave update endpoint persists Telegram to that table but does NOT echo
	 * it back in its snapshot, so these refs are the panel's own source of truth.
	 */
	telegramPrefs: Record<string, boolean>;
	/** Asset-event Telegram facets (calendar, ipo, analyst, insider). */
	assetEventTelegramPrefs?: Record<string, boolean>;
}

const props = withDefaults(defineProps<Props>(), {
	assetEventTelegramPrefs: () => ({}),
});
const { emailEnabled, phoneVerified, hasTrackedAssets, assetEventTelegramPrefs } =
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

const isHydrated = useHydrated();
const tick = ref(0);
let intervalId: number | null = null;

onMounted(() => {
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

/* =============
Telegram per-option state. These prefs live in `notification_preferences`
(channel='telegram'), not the users row, so they initialize from the server-loaded
`telegramPrefs` prop (absent facet ⇒ off) and are NOT re-synced from `user.value`
the way the email/sms refs are. Telegram is offered on every option — including
news/rumors, which are email-only on the legacy columns.
============= */
const includePricesTelegram = ref(props.telegramPrefs.prices === true);
const includeTopMoversTelegram = ref(props.telegramPrefs.top_movers === true);
const includeNewsTelegram = ref(props.telegramPrefs.news === true);
const includeRumorsTelegram = ref(props.telegramPrefs.rumors === true);

/** Telegram is selectable only once the account is linked (chat id present). */
const telegramConnected = computed(() => user.value.telegram_chat_id != null);
const telegramDisabledTitle = computed(() =>
	telegramConnected.value
		? undefined
		: "Connect Telegram in your notification channels to select this option.",
);

const dailyEnabled = computed(() =>
	includePricesEmail.value ||
	includePricesSms.value ||
	includePricesTelegram.value ||
	includeTopMoversEmail.value ||
	includeTopMoversSms.value ||
	includeTopMoversTelegram.value ||
	includeNewsEmail.value ||
	includeNewsTelegram.value ||
	includeRumorsEmail.value ||
	includeRumorsTelegram.value,
);

/* =============
Channel multiselect options. Each option carries its selected/disabled/title so the
multiselect can show every channel that exists for the facet (prices/top_movers get
Email+SMS+Telegram; news/rumors are Email+Telegram — no SMS) while still surfacing
why a channel is unavailable. Email/SMS disabled logic mirrors the prior checkboxes.
============= */
const { emailOption, smsOption, telegramOption } = createChannelOptionBuilders({
	emailDisabled: () => emailOnlyDisabled.value,
	emailDisabledTitle: () => emailDisabledTitle.value,
	smsDisabled: () => notificationSetupBlocked.value || !smsReady.value,
	smsDisabledTitle: () => smsDisabledTitle.value,
	telegramDisabled: () => !telegramConnected.value,
	telegramDisabledTitle: () => telegramDisabledTitle.value,
});

const pricesChannelOptions = computed<ChannelOption[]>(() => [
	emailOption(includePricesEmail.value),
	smsOption(includePricesSms.value),
	telegramOption(includePricesTelegram.value),
]);
const topMoversChannelOptions = computed<ChannelOption[]>(() => [
	emailOption(includeTopMoversEmail.value),
	smsOption(includeTopMoversSms.value),
	telegramOption(includeTopMoversTelegram.value),
]);
// News & Rumors are email-only on the legacy columns — no SMS channel offered.
const newsChannelOptions = computed<ChannelOption[]>(() => [
	emailOption(includeNewsEmail.value),
	telegramOption(includeNewsTelegram.value),
]);
const rumorsChannelOptions = computed<ChannelOption[]>(() => [
	emailOption(includeRumorsEmail.value),
	telegramOption(includeRumorsTelegram.value),
]);

function handlePricesToggle(channel: string, selected: boolean) {
	if (channel === "email") includePricesEmail.value = selected;
	else if (channel === "sms") includePricesSms.value = selected;
	else if (channel === "telegram") includePricesTelegram.value = selected;
}
function handleTopMoversToggle(channel: string, selected: boolean) {
	if (channel === "email") includeTopMoversEmail.value = selected;
	else if (channel === "sms") includeTopMoversSms.value = selected;
	else if (channel === "telegram") includeTopMoversTelegram.value = selected;
}
function handleNewsToggle(channel: string, selected: boolean) {
	if (channel === "email") includeNewsEmail.value = selected;
	else if (channel === "telegram") includeNewsTelegram.value = selected;
}
function handleRumorsToggle(channel: string, selected: boolean) {
	if (channel === "email") includeRumorsEmail.value = selected;
	else if (channel === "telegram") includeRumorsTelegram.value = selected;
}

const hasAnyAssetEventsOptionEnabled = computed(
	() =>
		user.value.asset_events_include_calendar_email ||
		user.value.asset_events_include_calendar_sms ||
		props.telegramPrefs.calendar === true ||
		user.value.asset_events_include_ipo_email ||
		user.value.asset_events_include_ipo_sms ||
		props.telegramPrefs.ipo === true ||
		user.value.asset_events_include_analyst_email ||
		user.value.asset_events_include_analyst_sms ||
		props.telegramPrefs.analyst === true ||
		user.value.asset_events_include_insider_email ||
		user.value.asset_events_include_insider_sms ||
		props.telegramPrefs.insider === true,
);

/** Derive the current delivery time input from the shared user state (managed by NotificationChannelsPanel). */
const dailyDeliveryTimeInput = computed(() => {
	const minutes = user.value.daily_notification_time;
	return minutes !== null && minutes !== undefined
		? minutesToTimeInputValue(minutes)
		: null;
});

/**
 * Stored `market_scheduled_asset_price_times` are ET-canonical minutes (Phase 9
 * migration). Convert each to user-local before deriving the earliest, so the
 * fallback `daily_digest_time` submitted from this form stays in user-local
 * space — the API converts to ET at the boundary on save.
 */
function getEarliestMarketNotificationTime(): number | null {
	const times = user.value.market_scheduled_asset_price_times;
	if (!times || times.length === 0) return null;
	const local = times.map((et) => etMinuteToUserLocal(et, user.value.timezone));
	return Math.min(...local);
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

const dailyNotificationEnabled = computed(
	() => dailyEnabled.value || hasAnyAssetEventsOptionEnabled.value,
);

const nextDailyDeliveryText = computed(() => {
	if (!isHydrated.value || !dailyNotificationEnabled.value) return null;
	void tick.value;

	const nextSendAtIso = user.value.daily_notification_next_send_at;

	const secondsUntil = getSecondsUntilNextSend({
		nextSendAtIso,
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
		includePricesTelegram,
		includeTopMoversEmail,
		includeTopMoversSms,
		includeTopMoversTelegram,
		includeNewsEmail,
		includeNewsTelegram,
		includeRumorsEmail,
		includeRumorsTelegram,
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
		...(newData.asset_events_include_calendar_email !== undefined && {
			asset_events_include_calendar_email: newData.asset_events_include_calendar_email,
		}),
		...(newData.asset_events_include_calendar_sms !== undefined && {
			asset_events_include_calendar_sms: newData.asset_events_include_calendar_sms,
		}),
		...(newData.asset_events_include_ipo_email !== undefined && {
			asset_events_include_ipo_email: newData.asset_events_include_ipo_email,
		}),
		...(newData.asset_events_include_ipo_sms !== undefined && {
			asset_events_include_ipo_sms: newData.asset_events_include_ipo_sms,
		}),
		...(newData.asset_events_include_analyst_email !== undefined && {
			asset_events_include_analyst_email: newData.asset_events_include_analyst_email,
		}),
		...(newData.asset_events_include_analyst_sms !== undefined && {
			asset_events_include_analyst_sms: newData.asset_events_include_analyst_sms,
		}),
		...(newData.asset_events_include_insider_email !== undefined && {
			asset_events_include_insider_email: newData.asset_events_include_insider_email,
		}),
		...(newData.asset_events_include_insider_sms !== undefined && {
			asset_events_include_insider_sms: newData.asset_events_include_insider_sms,
		}),
		daily_notification_time: newData.daily_notification_time,
		daily_notification_next_send_at: newData.daily_notification_next_send_at,
		market_scheduled_asset_price_next_send_at: newData.market_scheduled_asset_price_next_send_at,
	};
});
</script>
