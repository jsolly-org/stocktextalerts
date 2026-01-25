<template>
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
			:timezones="timezones"
			:timezoneLoadError="timezoneLoadError"
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
			:initialSymbols="initialSymbols"
			:onFormChanged="notifyStocksChange"
			:flash-messages="stocksFlashMessages"
			:status-message="stocksStatusMessage"
			:status-tone="stocksStatusTone"
			:is-saving="isStocksSaving"
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
import { computed, ref, toRefs, watch } from "vue";
import {
	resolveDashboardSectionFromHash,
} from "../../lib/dashboard/sections";
import type { User } from "../../lib/db";
import { rootLogger } from "../../lib/logging";
import { formatMessage } from "../../lib/status-messages";
import type { TimezoneOption } from "../../lib/time/cache";
import {
	type PreferencesData,
	useAutoSaveForm,
} from "./composables/useAutoSavePreferences";
import {
	DASHBOARD_FORM_ID,
	DASHBOARD_STOCKS_FORM_ID,
} from "./constants";
import ScheduledNotificationsPanel from "./notifications/scheduled/ScheduledNotificationsPanel.vue";
import PreviewPanel from "./PreviewPanel.vue";
import PreferencesPanel from "./preferences/PreferencesPanel.vue";
import type { StockOption } from "./stocks/StockInput.vue";
import TrackedStocksPanel from "./stocks/TrackedStocksPanel.vue";

interface Props {
	user: User;
	timezones: TimezoneOption[];
	stockOptions: StockOption[];
	initialSymbols: string[];
	isEditingPhone: boolean;
	timezoneLoadError?: boolean;
	successMessage?: string | null;
	errorMessage?: string | null;
	warningMessage?: string | null;
}

const props = withDefaults(defineProps<Props>(), {
	timezoneLoadError: false,
	successMessage: null,
	errorMessage: null,
	warningMessage: null,
});

const {
	initialSymbols,
	isEditingPhone,
	stockOptions,
	successMessage,
	errorMessage,
	warningMessage,
	timezones,
	timezoneLoadError,
	user,
} = toRefs(props);

const emailEnabled = ref(user.value.email_notifications_enabled);
const smsEnabled = ref(user.value.sms_notifications_enabled);
const smsOptedOut = computed(() => user.value.sms_opted_out);
const phoneVerified = computed(() => user.value.phone_verified);

watch(
	() => user.value.email_notifications_enabled,
	(newValue) => {
		emailEnabled.value = newValue;
	},
);

watch(
	() => user.value.sms_notifications_enabled,
	(newValue) => {
		smsEnabled.value = newValue;
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

type FlashSection = "preferences" | "stocks" | "scheduled" | "preview";

const explicitSection = (() => {
	const hash = typeof window !== "undefined" ? window.location.hash : "";
	return resolveDashboardSectionFromHash(hash);
})();

const PREFERENCES_KEYS = new Set([
	"settings_updated",
	"timezone_updated",
	"timezone_banner_dismissed",
	"phone_verified",
	"verification_failed",
	"invalid_code",
	"phone_not_set",
	"failed_to_update_settings",
	"failed_to_update_timezone",
	"failed_to_dismiss_timezone_banner",
]);
const STOCKS_KEYS = new Set([
	"stocks_updated",
	"stocks_limit",
	"failed_to_update_stocks",
]);
const SCHEDULED_KEYS = new Set([
	"daily_digest_sent",
	"daily_digest_disabled",
	"daily_digest_send_failed",
	"daily_digest_rate_limited",
	"daily_digest_timed_out",
	"daily_digest_skip_failed",
	"daily_digest_skip_update_failed",
	"notifications_not_configured",
]);
const PREVIEW_KEYS = new Set([
	"preview_email_sent",
	"preview_sms_sent",
	"preview_rate_limited",
	"preview_rate_limit_unexpected",
	"preview_sms_missing_phone",
	"preview_sms_unverified",
	"preview_sms_unavailable",
	"preview_failed",
	"email_notifications_disabled",
	"sms_notifications_disabled",
	"sms_opted_out",
]);

function resolveSectionFromKey(messageKey: string | null): FlashSection | null {
	if (!messageKey) {
		return null;
	}
	if (PREFERENCES_KEYS.has(messageKey)) return "preferences";
	if (STOCKS_KEYS.has(messageKey)) return "stocks";
	if (SCHEDULED_KEYS.has(messageKey)) return "scheduled";
	if (PREVIEW_KEYS.has(messageKey)) return "preview";
	if (messageKey === "invalid_form") return "preferences";
	if (messageKey === "server_error") return "preferences";
	if (messageKey === "update_failed") return "preferences";
	return null;
}

function getFlashMessagesForSection(
	targetSection: FlashSection,
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
		errorMessage.value,
		warningMessage.value,
	);
});

const stocksFlashMessages = computed<FlashMessage[]>(() => {
	return getFlashMessagesForSection(
		"stocks",
		successMessage.value,
		errorMessage.value,
		warningMessage.value,
	);
});

const scheduledFlashMessages = computed<FlashMessage[]>(() => {
	return getFlashMessagesForSection(
		"scheduled",
		successMessage.value,
		errorMessage.value,
		warningMessage.value,
	);
});

const previewFlashMessages = computed<FlashMessage[]>(() => {
	return getFlashMessagesForSection(
		"preview",
		successMessage.value,
		errorMessage.value,
		warningMessage.value,
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

	if (isVerifyCodeSubmission) {
		isVerifyingCode.value = true;
		return;
	}

	if (isSendVerificationSubmission) {
		isSendingVerification.value = true;
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
