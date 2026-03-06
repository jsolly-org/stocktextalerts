<template>
	<form
		ref="notificationPreferencesFormElement"
		:id="DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID"
		method="POST"
		action="/api/notification-preferences/update"
		aria-label="Notification preferences"
		:aria-busy="isSaving"
		@input="handleFormInput"
		@change="handleFormChange"
		@submit="handleFormSubmitWrapper"
	>
		<section
			class="card relative"
			data-notification-channels-card
			:data-form-id="DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID"
		>
			<FadeTransition>
				<div
					v-if="statusMessage"
					:id="DASHBOARD_NOTIFICATION_PREFERENCES_STATUS_ID"
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

			<div :class="`card-accent ${CARD_GRADIENT_ACCENTS.primary}`"></div>
			<div class="card-body">

			<div v-if="flashMessages.length" class="space-y-2 mb-4">
				<StatusMessage
					v-for="(flash, index) in flashMessages"
					:key="index"
					:tone="flash.tone"
				>
					{{ flash.message }}
				</StatusMessage>
			</div>

			<NotificationChannelsFieldset
				v-model:emailEnabled="emailEnabledModel"
				v-model:smsNotificationsEnabled="smsNotificationsEnabled"
				:sms-opted-out="smsOptedOut"
				:sms-phone-number="props.smsPhoneNumber"
				:is-saving="isSaving"
				:email-notifications-enabled-id="emailNotificationsEnabledId"
				:sms-status-id="smsStatusId"
				:notification-channels-desc-id="notificationChannelsDescId"
				:daily-delivery-time-input="dailyDeliveryTimeInput"
				:daily-delivery-time-minutes="dailyDeliveryTimeMinutes"
				:is24="user.use_24_hour_time"
				:before-open-label="beforeOpenLabel"
				:is-before-open-time="isBeforeOpenTime"
				@daily-time-change="handleDailyTimeChange"
				@clear-delivery-time="handleClearDeliveryTime"
				@set-before-open="handleSetBeforeOpen"
			/>
			</div>
		</section>
	</form>

	<!-- Notification Preview -->
	<section class="card">
		<div :class="`card-accent ${CARD_GRADIENT_ACCENTS.gray}`"></div>
		<div class="card-body">
			<header class="mb-4">
				<h2 class="text-xl sm:text-2xl font-bold text-heading">
					Notification Preview
				</h2>
				<p class="text-sm text-body-secondary mt-1">
					Preview your SMS notification. Formatting changes still apply to both SMS and email.
				</p>
			</header>

			<SetupRequiredNotice
				:needsTrackedAssets="needsTrackedAssets"
				:needsChannelSelection="needsChannelSelection"
				:needsPhoneVerification="false"
				phoneVerificationSectionId=""
			/>

			<div
				class="transition-opacity duration-200"
				:class="{ 'opacity-50': notificationSetupBlocked }"
			>
				<div class="mb-6">
					<div class="preview-slide">
						<SmsPreview :assets="previewAssets" />
					</div>
				</div>
			</div>
		</div>
	</section>
</template>

<script lang="ts" setup>
import { computed, ref, toRefs, watch } from "vue";
// ?component suffix required: Astro Icon cannot be used in Vue; vite-svg-loader compiles this to a Vue component.
import ArrowPathIcon from "../../../icons/arrow-path.svg?component";
import { fetchCurrentNotificationPreferences } from "../../../lib/api/notification-preferences";
import {
	CARD_GRADIENT_ACCENTS,
	DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID,
	DASHBOARD_NOTIFICATION_PREFERENCES_STATUS_ID,
	type FlashMessage,
	type FlashTone,
	formatMessage,
	STATUS_TONE_CLASSES,
} from "../../../lib/constants";
import {
	formatMinutesAsLocalTime,
	getUsBeforeOpenLocalMinutes,
	minutesToTimeInputValue,
	parseTimeToMinutes,
} from "../../../lib/time/format";
import FadeTransition from "../../FadeTransition.vue";
import StatusMessage from "../../StatusMessage.vue";
import type { InitialAsset } from "../assets/types";
import {
	type NotificationPreferencesData,
	useAutoSaveForm,
} from "../composables/useAutoSaveNotificationPreferences";
import { useDashboardUser } from "../composables/useDashboardUser";
import { provideSmsVerificationContext } from "../composables/useSmsVerificationContext";
import { useSmsVerificationSubmission } from "../composables/useSmsVerificationSubmission";
import { DEMO_ASSETS, type PreviewAsset } from "../daily-digest/preview/preview-data";
import SmsPreview from "../daily-digest/preview/SmsPreview.vue";
import SetupRequiredNotice from "../shared/SetupRequiredNotice.vue";
import NotificationChannelsFieldset from "./NotificationChannelsFieldset.vue";

interface Props {
	emailEnabled: boolean;
	smsPhoneNumber: string;
	initialAssets: InitialAsset[];
	hasTrackedAssets: boolean;
}

const props = defineProps<Props>();
const { emailEnabled: emailEnabledProp } = toRefs(props);

const emit = defineEmits<(event: "update:emailEnabled", value: boolean) => void>();

// Inject the shared mutable user ref from DashboardPanels
const user = useDashboardUser();

const isEditingPhone = ref(false);

/* ============= Auto-save composable ============= */
const notificationPreferencesFormElement = ref<HTMLFormElement | null>(null);
const {
	handleFormChange,
	handleFormInput,
	handleFormSubmit,
	isSaving,
	notifyChange,
	savedData: savedNotificationPreferencesData,
	statusMessage,
	statusTone,
} = useAutoSaveForm<NotificationPreferencesData>({
	formRef: notificationPreferencesFormElement,
});

/* ============= Flash messages ============= */
const flashMessages = ref<FlashMessage[]>([]);
const smsSuccessMessage = ref<string | null>(null);

function clearFlashTone(tone: FlashTone) {
	flashMessages.value = flashMessages.value.filter(
		(item) => item.tone !== tone,
	);
}

function setFlashMessage(tone: FlashTone, messageKey: string) {
	const message = formatMessage(messageKey);
	if (!message) return;

	// Clear the other two tones, keeping only the incoming one
	const otherTones: FlashTone[] = (
		["success", "error", "warning"] as const
	).filter((t) => t !== tone);
	for (const t of otherTones) clearFlashTone(t);

	const existing = flashMessages.value.findIndex(
		(item) => item.tone === tone,
	);
	const newMessage = { tone, message };
	if (existing >= 0) {
		flashMessages.value.splice(existing, 1, newMessage);
	} else {
		flashMessages.value.push(newMessage);
	}
}

/* ============= SMS verification ============= */
async function handleNotificationPreferencesUpdated() {
	const notificationPreferences = await fetchCurrentNotificationPreferences();
	if (notificationPreferences) {
		savedNotificationPreferencesData.value = notificationPreferences;
	}
}

const sendVerificationDisabled = ref(true);

const { handleSmsVerificationSubmit, isSendingVerification, isVerifyingCode } =
	useSmsVerificationSubmission({
		isEditingPhone,
		user,
		smsSuccessMessage,
		setNotificationPreferencesFlashMessage: setFlashMessage,
		clearNotificationPreferencesFlashTone: clearFlashTone,
		handleNotificationPreferencesUpdated,
	});

// Provide SMS verification state so descendants can inject instead of prop-drilling
provideSmsVerificationContext({
	isEditingPhone,
	smsSuccessMessage,
	sendVerificationDisabled,
	isVerifyingCode,
	isSendingVerification,
});

async function handleFormSubmitWrapper(event: SubmitEvent) {
	const handled = await handleSmsVerificationSubmit(event);
	if (handled) return;
	await handleFormSubmit(event);
}

/* ============= Channel state ============= */
const emailNotificationsEnabledId = `${DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID}-email_notifications_enabled`;
const smsStatusId = `${DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID}-sms_status`;
const notificationChannelsDescId = `${DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID}-notification-channels-desc`;

const emailEnabledModel = computed({
	get: () => emailEnabledProp.value,
	set: (value: boolean) => emit("update:emailEnabled", value),
});

const phoneVerified = computed(() => user.value.phone_verified === true);
const smsOptedOut = computed(() => user.value.sms_opted_out === true);
const smsNotificationsEnabled = computed({
	get: () => user.value.sms_notifications_enabled === true,
	set: (value: boolean) => {
		user.value = { ...user.value, sms_notifications_enabled: value };
	},
});
watch([emailEnabledModel, smsNotificationsEnabled], () => {
	notifyChange();
});

// Watch savedData and update shared user ref directly (no more event bubbling)
watch(
	() => savedNotificationPreferencesData.value,
	(newData) => {
		if (newData) {
			// Update shared user ref directly
			user.value = {
				...user.value,
				email_notifications_enabled: newData.email_notifications_enabled,
				sms_notifications_enabled: newData.sms_notifications_enabled,
				sms_opted_out: newData.sms_opted_out,
				phone_verified: newData.phone_verified,
				daily_digest_time: newData.daily_digest_time,
				daily_digest_next_send_at: newData.daily_digest_next_send_at,
				asset_events_next_send_at: newData.asset_events_next_send_at,
				market_scheduled_asset_price_next_send_at: newData.market_scheduled_asset_price_next_send_at,
			};
			// Sync channel state with parent
			emit("update:emailEnabled", newData.email_notifications_enabled);
		}
	},
);

// When phone becomes verified: exit phone-edit mode
watch(phoneVerified, (isVerified) => {
	if (isVerified) {
		isEditingPhone.value = false;
	}
});

/* ============= Daily Delivery Time ============= */

function getEarliestMarketNotificationTime(): number | null {
	const times = user.value.market_scheduled_asset_price_times;
	if (!times || times.length === 0) return null;
	return Math.min(...times);
}

const dailyDeliveryTimeMinutes = ref<number | null>(
	user.value.daily_digest_time ?? getEarliestMarketNotificationTime(),
);

const dailyDeliveryTimeInput = computed(() =>
	dailyDeliveryTimeMinutes.value !== null
		? minutesToTimeInputValue(dailyDeliveryTimeMinutes.value)
		: null,
);

const beforeOpenLocalMinutes = computed(() =>
	user.value.timezone ? getUsBeforeOpenLocalMinutes(user.value.timezone) : null,
);

const beforeOpenLabel = computed(() =>
	beforeOpenLocalMinutes.value !== null
		? formatMinutesAsLocalTime(beforeOpenLocalMinutes.value, user.value.use_24_hour_time)
		: null,
);

const isBeforeOpenTime = computed(() => {
	if (beforeOpenLocalMinutes.value === null) return true;
	return dailyDeliveryTimeMinutes.value === beforeOpenLocalMinutes.value;
});

function handleDailyTimeChange(value: string) {
	const parsed = parseTimeToMinutes(value);
	if (parsed === null) return;
	dailyDeliveryTimeMinutes.value = parsed;
	notifyChange();
}

function handleClearDeliveryTime() {
	dailyDeliveryTimeMinutes.value = null;
	notifyChange();
}

function handleSetBeforeOpen() {
	if (beforeOpenLocalMinutes.value === null || isBeforeOpenTime.value) return;
	dailyDeliveryTimeMinutes.value = beforeOpenLocalMinutes.value;
	notifyChange();
}

// Sync delivery time from user state (e.g. after save from another panel)
watch(
	() => user.value.daily_digest_time,
	(value) => {
		dailyDeliveryTimeMinutes.value = value ?? getEarliestMarketNotificationTime();
	},
);
watch(
	() => user.value.market_scheduled_asset_price_times,
	(times) => {
		if (user.value.daily_digest_time !== null) return;
		dailyDeliveryTimeMinutes.value =
			times && times.length > 0 ? getEarliestMarketNotificationTime() : null;
	},
);

/* ============= Notification Preview ============= */
const needsTrackedAssets = computed(() => !props.hasTrackedAssets);
const hasAnySmsFeatureEnabled = computed(
	() =>
		user.value.daily_digest_include_prices_sms ||
		user.value.market_scheduled_asset_price_include_sms ||
		user.value.asset_events_include_calendar_sms ||
		user.value.asset_events_include_ipo_sms ||
		user.value.asset_events_include_analyst_sms ||
		user.value.asset_events_include_insider_sms ||
		user.value.market_asset_price_alerts_include_sms,
);
const hasNotificationChannel = computed(
	() => emailEnabledProp.value || (smsNotificationsEnabled.value && hasAnySmsFeatureEnabled.value && phoneVerified.value && !smsOptedOut.value),
);
const needsChannelSelection = computed(() => !hasNotificationChannel.value);
const notificationSetupBlocked = computed(
	() => needsChannelSelection.value || needsTrackedAssets.value,
);

const previewAssets = computed<PreviewAsset[]>(() => {
	const assets = props.initialAssets;
	if (assets.length === 0) {
		return DEMO_ASSETS;
	}
	const demoData = [
		{ price: 195.5, changePercent: 2.4, sparkline: "▁▂▃▅▇▅▆", sparklineValues: [188, 190, 191, 193, 196, 194, 195] },
		{ price: 178.2, changePercent: 1.8, sparkline: "▃▂▁▃▅▆▇", sparklineValues: [174, 173, 172, 174, 176, 177, 178] },
		{ price: 248.3, changePercent: -0.5, sparkline: "▇▆▅▃▂▃▁", sparklineValues: [255, 253, 252, 250, 249, 250, 248] },
	];
	return assets.slice(0, 3).map((asset, i) => ({
		symbol: asset.symbol,
		name: asset.name,
		price: demoData[i % demoData.length].price,
		changePercent: demoData[i % demoData.length].changePercent,
		sparkline: demoData[i % demoData.length].sparkline,
		sparklineValues: demoData[i % demoData.length].sparklineValues,
	}));
});
</script>

<style scoped>
.preview-slide {
	min-width: 0;
	display: flex;
	justify-content: center;
}
</style>
