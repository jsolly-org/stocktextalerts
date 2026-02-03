<template>
	<form
		ref="stocksFormElement"
		:id="DASHBOARD_STOCKS_FORM_ID"
		method="POST"
		action="/api/stocks/update"
		class="space-y-6"
		:aria-busy="isStocksSaving"
		@input="handleStocksFormInput"
		@change="handleStocksFormChange"
		@submit="handleStocksFormSubmit"
	>
		<TrackedStocksPanel
			:stockOptions="stockOptions"
			:initialStocks="initialStocks"
			:onFormChanged="notifyStocksChange"
			:status-message="stocksStatusMessage"
			:status-tone="stocksStatusTone"
			:is-saving="isStocksSaving"
		/>
	</form>

	<form
		ref="notificationPreferencesFormElement"
		:id="DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID"
		method="POST"
		action="/api/notification-preferences/update"
		class="space-y-6"
		:aria-busy="isNotificationPreferencesSaving"
		@input="handleNotificationPreferencesFormInput"
		@change="handleNotificationPreferencesFormChange"
		@submit="handleNotificationPreferencesFormSubmitWrapper"
	>
		<NotificationChannelsPanel
			:user="user"
			:isEditingPhone="isEditingPhone"
			:successMessage="smsSuccessMessage"
			:emailEnabled="emailEnabled"
			:smsEnabled="smsEnabled"
			:onFormChanged="notifyNotificationPreferencesChange"
			:flash-messages="notificationPreferencesFlashMessages"
			:status-message="notificationPreferencesStatusMessage"
			:status-tone="notificationPreferencesStatusTone"
			:is-saving="isNotificationPreferencesSaving"
			:is-verifying-code="isVerifyingCode"
			:is-sending-verification="isSendingVerification"
			@update:emailEnabled="emailEnabled = $event"
			@update:smsEnabled="smsEnabled = $event"
			@phone-editing-changed="isEditingPhone = $event"
		/>

		<ScheduledNotificationsPanel
			:user="user"
			:emailEnabled="emailEnabled"
			:smsEnabled="smsEnabled"
			:phoneVerified="phoneVerified"
			:onFormChanged="notifyNotificationPreferencesChange"
			:savedNotificationPreferences="savedNotificationPreferences"
		/>
	</form>
</template>

<script lang="ts" setup>
import { computed, ref, toRefs, watch } from "vue";
import {
	DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID,
	DASHBOARD_STOCKS_FORM_ID,
	type FlashMessage,
	type FlashTone,
	formatMessage,
} from "../../lib/constants";
import type { User } from "../../lib/db";
import { fetchCurrentNotificationPreferences } from "../../lib/notification-preferences/fetch-current";
import {
	type NotificationPreferencesData,
	useAutoSaveForm,
} from "./composables/useAutoSaveNotificationPreferences";
import { useSmsVerificationSubmission } from "./composables/useSmsVerificationSubmission";
import NotificationChannelsPanel from "./notification-channels/NotificationChannelsPanel.vue";
import ScheduledNotificationsPanel from "./notifications/scheduled/ScheduledNotificationsPanel.vue";
import type { StockOption } from "./stocks/StockInput.vue";
import TrackedStocksPanel from "./stocks/TrackedStocksPanel.vue";
import type { InitialStock } from "./stocks/types";

interface Props {
	user: User;
	stockOptions: StockOption[];
	initialStocks: InitialStock[];
}

const props = defineProps<Props>();

const {
	initialStocks,
	stockOptions,
	user: userProp,
} = toRefs(props);

const isEditingPhone = ref(false);

// Local reactive copy of user that can be updated after sending verification
const user = ref<User>({ ...userProp.value });

// Sync with prop changes (e.g., after page reload)
watch(userProp, (newUser) => {
	user.value = { ...newUser };
}, { deep: true });

const emailEnabled = ref(user.value.email_notifications_enabled);
// Initialize smsEnabled, but allow NotificationChannelsPanel to restore pending state
const smsEnabled = ref(user.value.sms_notifications_enabled);
const phoneVerified = computed(() => user.value.phone_verified);

watch(
	() => user.value.email_notifications_enabled,
	(newValue) => {
		emailEnabled.value = newValue;
	},
);

// Track if we've restored pending SMS state to avoid overwriting it
let hasRestoredPendingSms = false;

watch(
	() => user.value.sms_notifications_enabled,
	(newValue) => {
		// Don't overwrite if we've restored pending state and the new value is false
		// (this means the server has false because phone isn't verified, but we want to keep it enabled)
		if (hasRestoredPendingSms && !newValue && smsEnabled.value) {
			return;
		}
		smsEnabled.value = newValue;
	},
);

// Watch for when NotificationChannelsPanel restores pending SMS state
watch(smsEnabled, (newValue) => {
	if (newValue && !user.value.phone_verified) {
		hasRestoredPendingSms = true;
	} else if (!newValue || user.value.phone_verified) {
		// Reset flag when SMS is disabled or phone becomes verified
		hasRestoredPendingSms = false;
	}
});

// When phone becomes verified: clear pending-SMS restore flag and exit phone-edit mode
watch(
	() => user.value.phone_verified,
	(isVerified) => {
		if (isVerified) {
			hasRestoredPendingSms = false;
			isEditingPhone.value = false;
		}
	},
);


const notificationPreferencesFormElement = ref<HTMLFormElement | null>(null);
const stocksFormElement = ref<HTMLFormElement | null>(null);
const {
	handleFormChange: handleNotificationPreferencesFormChange,
	handleFormInput: handleNotificationPreferencesFormInput,
	handleFormSubmit: handleNotificationPreferencesFormSubmit,
	isSaving: isNotificationPreferencesSaving,
	notifyChange: notifyNotificationPreferencesChange,
	savedData: savedNotificationPreferencesData,
	statusMessage: notificationPreferencesStatusMessage,
	statusTone: notificationPreferencesStatusTone,
} = useAutoSaveForm<NotificationPreferencesData>({
	formRef: notificationPreferencesFormElement,
});

const savedNotificationPreferences = savedNotificationPreferencesData;

// Update user state when notification-preferences are refreshed
watch(
	() => savedNotificationPreferencesData.value,
	(newNotificationPreferences) => {
		if (newNotificationPreferences) {
			user.value = {
				...user.value,
				email_notifications_enabled:
					newNotificationPreferences.email_notifications_enabled,
				sms_notifications_enabled:
					newNotificationPreferences.sms_notifications_enabled,
				phone_verified: newNotificationPreferences.phone_verified,
				daily_digest_enabled: newNotificationPreferences.daily_digest_enabled,
				daily_digest_notification_times:
					newNotificationPreferences.daily_digest_notification_times,
				next_send_at: newNotificationPreferences.next_send_at,
			};
		}
	},
);

const notificationPreferencesFlashMessages = ref<FlashMessage[]>([]);
const smsSuccessMessage = ref<string | null>(null);

function upsertFlashMessage(
	target: typeof notificationPreferencesFlashMessages,
	tone: FlashTone,
	messageKey: string,
) {
	const message = formatMessage(messageKey);
	if (!message) {
		return;
	}
	const existingIndex = target.value.findIndex((item) => item.tone === tone);
	const newMessage = { tone, message };
	if (existingIndex >= 0) {
		target.value.splice(existingIndex, 1, newMessage);
	} else {
		target.value.push(newMessage);
	}
}

function clearFlashTone(
	target: typeof notificationPreferencesFlashMessages,
	tone: FlashTone,
) {
	target.value = target.value.filter((item) => item.tone !== tone);
}

function setNotificationPreferencesFlashMessage(
	tone: FlashTone,
	messageKey: string,
) {
	if (tone === "success") {
		clearFlashTone(notificationPreferencesFlashMessages, "error");
		clearFlashTone(notificationPreferencesFlashMessages, "warning");
	} else if (tone === "warning") {
		clearFlashTone(notificationPreferencesFlashMessages, "error");
		clearFlashTone(notificationPreferencesFlashMessages, "success");
	} else {
		clearFlashTone(notificationPreferencesFlashMessages, "success");
		clearFlashTone(notificationPreferencesFlashMessages, "warning");
	}
	upsertFlashMessage(notificationPreferencesFlashMessages, tone, messageKey);
}

const { handleSmsVerificationSubmit, isSendingVerification, isVerifyingCode } =
	useSmsVerificationSubmission({
		isEditingPhone,
		user,
		smsSuccessMessage,
		setNotificationPreferencesFlashMessage,
		clearNotificationPreferencesFlashTone: (tone) =>
			clearFlashTone(notificationPreferencesFlashMessages, tone),
		handleNotificationPreferencesUpdated,
	});

const {
	handleFormChange: handleStocksFormChange,
	handleFormInput: handleStocksFormInput,
	handleFormSubmit: handleStocksFormSubmit,
	isSaving: isStocksSaving,
	notifyChange: notifyStocksChange,
	statusMessage: stocksStatusMessage,
	statusTone: stocksStatusTone,
} = useAutoSaveForm({
	formRef: stocksFormElement,
});

async function handleNotificationPreferencesFormSubmitWrapper(
	event: SubmitEvent,
) {
	const handled = await handleSmsVerificationSubmit(event);
	if (handled) return;
	await handleNotificationPreferencesFormSubmit(event);
}

async function handleNotificationPreferencesUpdated() {
	const notificationPreferences = await fetchCurrentNotificationPreferences();
	if (notificationPreferences) {
		savedNotificationPreferencesData.value = notificationPreferences;
	}
}
</script>
