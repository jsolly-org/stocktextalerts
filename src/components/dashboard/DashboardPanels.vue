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
			:successMessage="successMessage"
			:emailEnabled="emailEnabled"
			:smsEnabled="smsEnabled"
			:onFormChanged="notifyPreferencesChange"
			:savedPreferences="savedPreferences"
			:flash-messages="preferencesFlashMessages"
			:status-message="preferencesStatusMessage"
			:status-tone="preferencesStatusTone"
			:is-saving="isPreferencesSaving"
			:is-verifying-code="isVerifyingCode"
			:is-sending-verification="isSendingVerification"
			@update:emailEnabled="emailEnabled = $event"
			@update:smsEnabled="smsEnabled = $event"
			@preferences-updated="handlePreferencesUpdated"
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

	<PreviewPanel
		:emailEnabled="emailEnabled"
		:smsEnabled="smsEnabled"
		:smsOptedOut="smsOptedOut"
		:phoneVerified="phoneVerified"
		:flash-messages="previewFlashMessages"
	/>
</template>

<script lang="ts" setup>
import { computed, nextTick, onMounted, onUnmounted, ref, toRefs, watch } from "vue";
import {
	DASHBOARD_FORM_ID,
	DASHBOARD_STOCKS_FORM_ID,
	type DashboardSection,
	FLASH_PARAM_KEYS,
	formatMessage,
	resolveDashboardSectionFromHash,
	resolveSectionFromKey,
} from "../../lib/constants";
import type { User } from "../../lib/db";
import { rootLogger } from "../../lib/logging";
import {
	type PreferencesData,
	useAutoSaveForm,
} from "./composables/useAutoSavePreferences";
import ScheduledNotificationsPanel from "./notifications/scheduled/ScheduledNotificationsPanel.vue";
import PreviewPanel from "./PreviewPanel.vue";
import PreferencesPanel from "./preferences/PreferencesPanel.vue";
import type { StockOption } from "./stocks/StockInput.vue";
import TrackedStocksPanel from "./stocks/TrackedStocksPanel.vue";

interface InitialStock {
	symbol: string;
	name: string;
}

interface Props {
	user: User;
	stockOptions: StockOption[];
	initialStocks: InitialStock[];
	isEditingPhone: boolean;
	successMessage?: string | null;
	errorMessage?: string | null;
	warningMessage?: string | null;
}

const props = withDefaults(defineProps<Props>(), {
	successMessage: null,
	errorMessage: null,
	warningMessage: null,
});

const {
	initialStocks,
	isEditingPhone: isEditingPhoneProp,
	stockOptions,
	successMessage,
	errorMessage,
	warningMessage,
	user: userProp,
} = toRefs(props);

// Local reactive state for isEditingPhone that can be updated from URL changes
const isEditingPhone = ref(isEditingPhoneProp.value);

// Local reactive state for error/warning messages that can be updated from client-side redirects
const localErrorMessage = ref<string | null>(errorMessage.value);
const localWarningMessage = ref<string | null>(warningMessage.value);

// Sync with prop changes (e.g., after page reload)
watch(errorMessage, (newValue) => {
	localErrorMessage.value = newValue;
});
watch(warningMessage, (newValue) => {
	localWarningMessage.value = newValue;
});

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

function updateIsEditingPhoneFromUrl() {
	const url = new URL(window.location.href);
	const newValue = url.searchParams.get("change_phone") === "1";

	// Reset the allowChangePhoneNavigation flag when exiting change_phone mode.
	// This intentionally happens even if `isEditingPhone` is already `false` so the
	// bypass can't persist across unrelated URL changes.
	if (!newValue) {
		(
			window as Window & { __allowChangePhoneNavigation?: boolean }
		).__allowChangePhoneNavigation = false;
	}

	if (isEditingPhone.value !== newValue) {
		isEditingPhone.value = newValue;
	}
}

onMounted(() => {
	const url = new URL(window.location.href);
	for (const key of FLASH_PARAM_KEYS) {
		url.searchParams.delete(key);
	}
	const current = url;
	if (current.toString() !== window.location.href) {
		window.history.replaceState(
			window.history.state,
			document.title,
			current.toString(),
		);
	}

	// Listen for URL changes from client-side navigation
	window.addEventListener("dashboard-url-changed", updateIsEditingPhoneFromUrl);
	// Also listen for browser back/forward navigation
	window.addEventListener("popstate", updateIsEditingPhoneFromUrl);

	// Initial check for pending SMS state
	updateIsEditingPhoneFromUrl();
});

onUnmounted(() => {
	window.removeEventListener("dashboard-url-changed", updateIsEditingPhoneFromUrl);
	window.removeEventListener("popstate", updateIsEditingPhoneFromUrl);
});

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
			};
		}
	},
);

type FlashTone = "success" | "error" | "warning";
type FlashMessage = { tone: FlashTone; message: string };

function createFlashMessage(
	tone: FlashTone,
	messageKey: string | null,
): FlashMessage | null {
	if (!messageKey) {
		return null;
	}
	const message = formatMessage(messageKey);
	if (!message) {
		return null;
	}
	return { tone, message };
}

const explicitSection = (() => {
	const hash = typeof window !== "undefined" ? window.location.hash : "";
	return resolveDashboardSectionFromHash(hash);
})();

function getFlashMessagesForSection(
	targetSection: DashboardSection,
	successKey: string | null,
	errorKey: string | null,
	warningKey: string | null,
): FlashMessage[] {
	const messages: FlashMessage[] = [];

	const successFlash = createFlashMessage("success", successKey);
	const errorFlash = createFlashMessage("error", errorKey);
	const warningFlash = createFlashMessage("warning", warningKey);

	const successSection =
		explicitSection ?? resolveSectionFromKey(successKey ?? null);
	const errorSection = explicitSection ?? resolveSectionFromKey(errorKey);
	const warningSection = explicitSection ?? resolveSectionFromKey(warningKey);

	if (successFlash && successSection === targetSection) messages.push(successFlash);
	if (warningFlash && warningSection === targetSection) messages.push(warningFlash);
	if (errorFlash && errorSection === targetSection) messages.push(errorFlash);

	return messages;
}

const preferencesFlashMessages = computed<FlashMessage[]>(() => {
	const successKey =
		successMessage.value === "verification_sent" ? null : successMessage.value;
	return getFlashMessagesForSection(
		"preferences",
		successKey,
		localErrorMessage.value,
		localWarningMessage.value,
	);
});

const stocksFlashMessages = computed<FlashMessage[]>(() => {
	return getFlashMessagesForSection(
		"stocks",
		successMessage.value,
		localErrorMessage.value,
		localWarningMessage.value,
	);
});

const scheduledFlashMessages = computed<FlashMessage[]>(() => {
	return getFlashMessagesForSection(
		"scheduled",
		successMessage.value,
		localErrorMessage.value,
		localWarningMessage.value,
	);
});

const previewFlashMessages = computed<FlashMessage[]>(() => {
	return getFlashMessagesForSection(
		"preview",
		successMessage.value,
		localErrorMessage.value,
		localWarningMessage.value,
	);
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
			});

			if (res.redirected && res.url) {
				const redirectedUrl = new URL(res.url);
				const success = redirectedUrl.searchParams.get("success");
				const error = redirectedUrl.searchParams.get("error");
				const warning = redirectedUrl.searchParams.get("warning");

				// Update local error/warning state from redirect URL for immediate feedback
				if (error) {
					localErrorMessage.value = error;
					if (!warning) {
						localWarningMessage.value = null;
					}
				} else if (success) {
					// Clear error on success
					localErrorMessage.value = null;
				}
				if (warning) {
					localWarningMessage.value = warning;
				} else if (success) {
					// Clear warning on success
					localWarningMessage.value = null;
				}

				// After successfully sending verification, update local user state
				// so the UI switches to the OTP interface immediately
				if (isSendVerificationSubmission && success === "verification_sent") {
					// Clear any previous error messages when sending a new verification
					localErrorMessage.value = null;
					localWarningMessage.value = null;
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
				if (isVerifyCodeSubmission && success === "phone_verified") {
					user.value = {
						...user.value,
						phone_verified: true,
						verification_sent_at: null,
					} as User & { verification_sent_at: null };
				}

				// Avoid full page navigation: it triggers beforeunload warnings and isn't needed
				// since we keep local `user` state in sync for the SMS flows.
				window.history.replaceState(
					window.history.state,
					document.title,
					redirectedUrl.toString(),
				);
				if (redirectedUrl.hash) {
					window.location.hash = redirectedUrl.hash;
				}

				// Keep preferences state in sync after verification (server may update more fields).
				if (isVerifyCodeSubmission && success === "phone_verified") {
					await handlePreferencesUpdated();
				}

				// Focus the first OTP digit after sending the verification code so the user
				// can immediately type/paste without extra clicks.
				if (isSendVerificationSubmission && success === "verification_sent") {
					await nextTick();
					const firstOtpInputId = `${DASHBOARD_FORM_ID}-sms-verification-code-0`;
					const otp0 = document.getElementById(firstOtpInputId);

					if (otp0 instanceof HTMLInputElement) {
						otp0.focus();
						otp0.select();
					}
				}
				return;
			}

			if (!res.ok) {
				localErrorMessage.value = "failed";
				localWarningMessage.value = null;
				return;
			}
		} catch {
			localErrorMessage.value = "failed";
			localWarningMessage.value = null;
		} finally {
			isVerifyingCode.value = false;
			isSendingVerification.value = false;
		}
		return;
	}

	await handlePreferencesFormSubmit(event);
}

async function handlePreferencesUpdated() {
	try {
		const response = await fetch("/api/preferences/current", {
			method: "GET",
			credentials: "same-origin",
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(10_000),
		});

		if (response.ok) {
			const payload = (await response.json()) as {
				ok: boolean;
				preferences?: PreferencesData;
			};
			if (payload.preferences) {
				savedPreferencesData.value = payload.preferences;
			}
		}
	} catch (error) {
		// Silently fail - preferences will refresh on next form change
		rootLogger.warn("Failed to refresh preferences", {
			action: "refresh_preferences",
			error,
		});
	}
}
</script>
