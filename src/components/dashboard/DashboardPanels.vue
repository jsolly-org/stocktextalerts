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
		ref="preferencesFormElement"
		:id="DASHBOARD_FORM_ID"
		method="POST"
		action="/api/preferences/update"
		class="space-y-6"
		:aria-busy="isPreferencesSaving"
		@input="handlePreferencesFormInput"
		@change="handlePreferencesFormChange"
		@submit="handlePreferencesFormSubmitWrapper"
	>
		<PreferencesPanel
			:user="user"
			:isEditingPhone="isEditingPhone"
			:successMessage="smsSuccessMessage"
			:emailEnabled="emailEnabled"
			:smsEnabled="smsEnabled"
			:onFormChanged="notifyPreferencesChange"
			:flash-messages="preferencesFlashMessages"
			:status-message="preferencesStatusMessage"
			:status-tone="preferencesStatusTone"
			:is-saving="isPreferencesSaving"
			:is-verifying-code="isVerifyingCode"
			:is-sending-verification="isSendingVerification"
			@update:emailEnabled="emailEnabled = $event"
			@update:smsEnabled="smsEnabled = $event"
			@preferences-updated="handlePreferencesUpdated"
			@phone-editing-changed="isEditingPhone = $event"
		/>

		<ScheduledNotificationsPanel
			:user="user"
			:emailEnabled="emailEnabled"
			:smsEnabled="smsEnabled"
			:smsOptedOut="smsOptedOut"
			:phoneVerified="phoneVerified"
			:onFormChanged="notifyPreferencesChange"
			:savedPreferences="savedPreferences"
		/>
	</form>
</template>

<script lang="ts" setup>
import { computed, ref, toRefs, watch } from "vue";
import {
	DASHBOARD_FORM_ID,
	DASHBOARD_STOCKS_FORM_ID,
	formatMessage,
} from "../../lib/constants";
import type { User } from "../../lib/db";
import { fetchCurrentPreferences } from "../../lib/preferences/fetch-current";
import {
	type PreferencesData,
	useAutoSaveForm,
} from "./composables/useAutoSavePreferences";
import { useSmsVerificationSubmission } from "./composables/useSmsVerificationSubmission";
import ScheduledNotificationsPanel from "./notifications/scheduled/ScheduledNotificationsPanel.vue";
import PreferencesPanel from "./preferences/PreferencesPanel.vue";
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
// Initialize smsEnabled, but allow PreferencesPanel to restore pending state
const smsEnabled = ref(user.value.sms_notifications_enabled);
const smsOptedOut = computed(() => user.value.sms_opted_out);
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

// Watch for when PreferencesPanel restores pending SMS state
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


const preferencesFormElement = ref<HTMLFormElement | null>(null);
const stocksFormElement = ref<HTMLFormElement | null>(null);
const {
	handleFormChange: handlePreferencesFormChange,
	handleFormInput: handlePreferencesFormInput,
	handleFormSubmit: handlePreferencesFormSubmit,
	isSaving: isPreferencesSaving,
	notifyChange: notifyPreferencesChange,
	savedData: savedPreferencesData,
	statusMessage: preferencesStatusMessage,
	statusTone: preferencesStatusTone,
} = useAutoSaveForm<PreferencesData>({
	formRef: preferencesFormElement,
});

const savedPreferences = savedPreferencesData;

// Update user state when preferences are refreshed
watch(
	() => savedPreferencesData.value,
	(newPreferences) => {
		if (newPreferences) {
			user.value = {
				...user.value,
				email_notifications_enabled: newPreferences.email_notifications_enabled,
				sms_notifications_enabled: newPreferences.sms_notifications_enabled,
				sms_opted_out: newPreferences.sms_opted_out,
				phone_verified: newPreferences.phone_verified,
				daily_digest_enabled: newPreferences.daily_digest_enabled,
				daily_digest_notification_times:
					newPreferences.daily_digest_notification_times,
				next_send_at: newPreferences.next_send_at,
			};
		}
	},
);

type FlashTone = "success" | "error" | "warning";
type FlashMessage = { tone: FlashTone; message: string };

const preferencesFlashMessages = ref<FlashMessage[]>([]);
const smsSuccessMessage = ref<string | null>(null);

function upsertFlashMessage(
	target: typeof preferencesFlashMessages,
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
	target: typeof preferencesFlashMessages,
	tone: FlashTone,
) {
	target.value = target.value.filter((item) => item.tone !== tone);
}

function setPreferencesFlashMessage(tone: FlashTone, messageKey: string) {
	if (tone === "success") {
		clearFlashTone(preferencesFlashMessages, "error");
		clearFlashTone(preferencesFlashMessages, "warning");
	} else if (tone === "warning") {
		clearFlashTone(preferencesFlashMessages, "error");
		clearFlashTone(preferencesFlashMessages, "success");
	} else {
		clearFlashTone(preferencesFlashMessages, "success");
		clearFlashTone(preferencesFlashMessages, "warning");
	}
	upsertFlashMessage(preferencesFlashMessages, tone, messageKey);
}

const { handleSmsVerificationSubmit, isSendingVerification, isVerifyingCode } =
	useSmsVerificationSubmission({
		isEditingPhone,
		user,
		smsSuccessMessage,
		setPreferencesFlashMessage,
		clearPreferencesFlashTone: (tone) =>
			clearFlashTone(preferencesFlashMessages, tone),
		handlePreferencesUpdated,
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

async function handlePreferencesFormSubmitWrapper(event: SubmitEvent) {
	const handled = await handleSmsVerificationSubmit(event);
	if (handled) return;
	await handlePreferencesFormSubmit(event);
}

async function handlePreferencesUpdated() {
	const prefs = await fetchCurrentPreferences();
	if (prefs) {
		savedPreferencesData.value = prefs;
	}
}
</script>
