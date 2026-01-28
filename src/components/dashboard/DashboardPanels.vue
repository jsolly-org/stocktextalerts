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
			:flash-messages="stocksFlashMessages"
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
			@phone-editing-changed="handlePhoneEditingChanged"
		/>

		<ScheduledNotificationsPanel
			:user="user"
			:emailEnabled="emailEnabled"
			:smsEnabled="smsEnabled"
			:smsOptedOut="smsOptedOut"
			:phoneVerified="phoneVerified"
			:onFormChanged="notifyPreferencesChange"
			:savedPreferences="savedPreferences"
			:flash-messages="scheduledFlashMessages"
		/>
	</form>
</template>

<script lang="ts" setup>
import { computed, nextTick, ref, toRefs, watch } from "vue";
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

// Reset flag when phone becomes verified
watch(
	() => user.value.phone_verified,
	(newValue) => {
		if (newValue) {
			hasRestoredPendingSms = false;
		}
	},
);

watch(
	() => user.value.phone_verified,
	(isVerified) => {
		if (isVerified) {
			isEditingPhone.value = false;
		}
	},
);


const preferencesFormElement = ref<HTMLFormElement | null>(null);
const stocksFormElement = ref<HTMLFormElement | null>(null);
const isVerifyingCode = ref(false);
const isSendingVerification = ref(false);
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
				daily_digest_notification_time:
					newPreferences.daily_digest_notification_time,
				next_send_at: newPreferences.next_send_at,
			};
		}
	},
);

type FlashTone = "success" | "error" | "warning";
type FlashMessage = { tone: FlashTone; message: string };

const preferencesFlashMessages = ref<FlashMessage[]>([]);
const stocksFlashMessages = ref<FlashMessage[]>([]);
const scheduledFlashMessages = ref<FlashMessage[]>([]);
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
	const submitter = event.submitter;
	const action =
		submitter instanceof HTMLElement ? submitter.getAttribute("formaction") : null;
	const isVerifyCodeSubmission = action === "/api/auth/sms/verify-code";
	const isSendVerificationSubmission = action === "/api/auth/sms/send-verification";

	if (isVerifyCodeSubmission || isSendVerificationSubmission) {
		event.preventDefault();
		if (isVerifyCodeSubmission) {
			isVerifyingCode.value = true;
		} else {
			isSendingVerification.value = true;
		}

		try {
			const form = event.target as HTMLFormElement;
			const formData = new FormData(form);

			const res = await fetch(action as string, {
				method: "POST",
				body: formData,
				credentials: "same-origin",
				headers: { Accept: "application/json" },
			});

			let payload: { ok: boolean; message?: string; tone?: FlashTone } | null =
				null;
			try {
				payload = (await res.json()) as {
					ok: boolean;
					message?: string;
					tone?: FlashTone;
				};
			} catch {
				payload = null;
			}

			if (!payload || typeof payload.message !== "string") {
				setPreferencesFlashMessage("error", "failed");
				smsSuccessMessage.value = null;
				return;
			}

			const messageKey = payload.message;
			const tone = payload.tone ?? (payload.ok ? "success" : "error");

			if (messageKey === "verification_sent") {
				smsSuccessMessage.value = "verification_sent";
				clearFlashTone(preferencesFlashMessages, "error");
				clearFlashTone(preferencesFlashMessages, "warning");
				isEditingPhone.value = false;
			} else {
				smsSuccessMessage.value = null;
				setPreferencesFlashMessage(tone, messageKey);
			}

			// After successfully sending verification, update local user state
			// so the UI switches to the OTP interface immediately
			if (isSendVerificationSubmission && messageKey === "verification_sent") {
				const phoneCountryCode = formData.get("phone_country_code") as string;
				const phoneNumber = formData.get("phone_number") as string;
				if (phoneCountryCode && phoneNumber) {
					user.value = {
						...user.value,
						phone_country_code: phoneCountryCode,
						phone_number: phoneNumber,
						phone_verified: false,
						sms_notifications_enabled: true,
						verification_sent_at: new Date().toISOString(),
					} as User & { verification_sent_at: string };
				}
			}

			// After successfully verifying the code, update local user state so the UI
			// shows "Phone verified" without requiring a refresh.
			if (isVerifyCodeSubmission && messageKey === "phone_verified") {
				user.value = {
					...user.value,
					phone_verified: true,
					verification_sent_at: null,
				} as User & { verification_sent_at: null };
				isEditingPhone.value = false;
			}

			// Keep preferences state in sync after verification (server may update more fields).
			if (isVerifyCodeSubmission && messageKey === "phone_verified") {
				await handlePreferencesUpdated();
			}

			// Focus the first OTP digit after sending the verification code so the user
			// can immediately type/paste without extra clicks.
			if (isSendVerificationSubmission && messageKey === "verification_sent") {
				await nextTick();
				const firstOtpInputId = `${DASHBOARD_FORM_ID}-sms-verification-code-0`;
				const otp0 = document.getElementById(firstOtpInputId);

				if (otp0 instanceof HTMLInputElement) {
					otp0.focus();
					otp0.select();
				}
			}
			return;
		} catch {
			setPreferencesFlashMessage("error", "failed");
			smsSuccessMessage.value = null;
		} finally {
			isVerifyingCode.value = false;
			isSendingVerification.value = false;
		}
		return;
	}

	await handlePreferencesFormSubmit(event);
}

async function handlePreferencesUpdated() {
	const prefs = await fetchCurrentPreferences();
	if (prefs) {
		savedPreferencesData.value = prefs;
	}
}

function handlePhoneEditingChanged(value: boolean) {
	isEditingPhone.value = value;
}
</script>
