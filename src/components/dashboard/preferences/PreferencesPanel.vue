<template>
	<div
		class="mb-6 bg-white rounded-lg shadow-sm border border-gray-200 p-6"
		data-notification-preferences-card
		:data-form-id="DASHBOARD_FORM_ID"
	>
		<h2 id="notification-preferences" class="text-2xl font-bold text-gray-900 mb-4">
			Notification Preferences
		</h2>

		<div class="space-y-6">
			<TimezoneSelect
				:id="`${DASHBOARD_FORM_ID}-timezone`"
				v-model="selectedTimezone"
				:timezones="timezones"
				:disabled="timezoneLoadError"
				@change="notifyFormChanged"
			/>

			<TimezoneMismatchBanner
				:is-client="isClient"
				:saved-timezone="user.timezone"
				:allowed-timezones="timezones.map((tz) => tz.value)"
				:dismiss-timezone-mismatch-prompts="user.dismiss_timezone_mismatch_prompts"
				:saved-preferences="savedPreferences"
				@timezone-updated="handleTimezoneUpdated"
			/>

			<NotificationChannelsSection
				v-model:email-enabled="emailEnabled"
				v-model:sms-enabled="smsEnabled"
				:user="user"
				:can-save-sms-enabled="canSaveSmsEnabled"
				:is-editing-phone="isEditingPhone"
				:send-verification-disabled="sendVerificationDisabled"
				:success-message="successMessage"
				:is-verifying-code="isVerifyingCode"
				@phone-validity-changed="handlePhoneValidityChanged"
			/>
		</div>
	</div>
</template>

<script lang="ts" setup>
import { DateTime } from "luxon";
import { computed, onMounted, onUnmounted, ref, toRefs, watch } from "vue";

import type { User } from "../../../lib/db";
import { rootLogger } from "../../../lib/logging";
import type { TimezoneOption } from "../../../lib/time/cache";
import { DEFAULT_TIMEZONE } from "../../../lib/time/constants";
import { DASHBOARD_FORM_ID } from "../constants";
import NotificationChannelsSection from "./NotificationChannelsSection.vue";
import TimezoneMismatchBanner from "./TimezoneMismatchBanner.vue";
import TimezoneSelect from "./TimezoneSelect.vue";

interface Props {
	user: User;
	timezones: TimezoneOption[];
	isEditingPhone: boolean;
	emailEnabled: boolean;
	smsEnabled: boolean;
	onFormChanged: () => void;
	timezoneLoadError?: boolean;
	successMessage?: string | null;
	savedPreferences?: {
		email_notifications_enabled: boolean;
		sms_notifications_enabled: boolean;
		sms_opted_out: boolean;
		phone_verified: boolean;
		timezone: string;
		daily_digest_enabled: boolean;
		daily_digest_notification_time: number;
		next_send_at: string | null;
		dismiss_timezone_mismatch_prompts: boolean;
	} | null;
	isVerifyingCode?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
	timezoneLoadError: false,
	successMessage: null,
});
const {
	emailEnabled: emailEnabledProp,
	smsEnabled: smsEnabledProp,
	isEditingPhone,
	isVerifyingCode,
	onFormChanged,
	savedPreferences,
	successMessage,
	timezones,
	timezoneLoadError,
	user,
} = toRefs(props);

const emit = defineEmits<{
	(event: "update:emailEnabled", value: boolean): void;
	(event: "update:smsEnabled", value: boolean): void;
}>();

const sendVerificationDisabled = ref(true);
const isClient = ref(false);
let cleanupNavigationWarning: (() => void) | undefined;

const PENDING_SMS_STORAGE_KEY = "pending_sms_enabled";

const pendingSmsStorageKey = computed(() => {
	return `${PENDING_SMS_STORAGE_KEY}:${user.value.id}`;
});

const emailEnabled = computed({
	get: () => emailEnabledProp.value,
	set: (value: boolean) => emit("update:emailEnabled", value),
});
const smsEnabled = computed({
	get: () => smsEnabledProp.value,
	set: (value: boolean) => emit("update:smsEnabled", value),
});
const selectedTimezone = ref(user.value.timezone);

const canSaveSmsEnabled = computed(() => {
	if (!smsEnabled.value) {
		return true;
	}
	return user.value.phone_verified === true;
});

const hasPendingSmsChanges = computed(() => {
	return smsEnabled.value && !user.value.phone_verified;
});

function savePendingSmsState() {
	try {
		if (hasPendingSmsChanges.value) {
			sessionStorage.setItem(pendingSmsStorageKey.value, "true");
		} else {
			sessionStorage.removeItem(pendingSmsStorageKey.value);
		}
	} catch (error) {
		rootLogger.warn(
			"Unable to update session storage for pending SMS changes.",
			{
				storageKey: pendingSmsStorageKey.value,
				error,
			},
		);
	}
}

function restorePendingSmsState() {
	let pendingSmsState: string | null = null;
	try {
		pendingSmsState = sessionStorage.getItem(pendingSmsStorageKey.value);
	} catch (error) {
		rootLogger.warn("Unable to read session storage for pending SMS changes.", {
			storageKey: pendingSmsStorageKey.value,
			error,
		});
		return;
	}

	if (user.value.phone_verified && pendingSmsState === "true") {
		smsEnabled.value = true;
		try {
			sessionStorage.removeItem(pendingSmsStorageKey.value);
		} catch (error) {
			rootLogger.warn(
				"Unable to clear session storage for pending SMS changes.",
				{
					storageKey: pendingSmsStorageKey.value,
					error,
				},
			);
		}
	}
}

function resolveDefaultTimezone() {
	if (selectedTimezone.value) {
		return;
	}

	const knownValues = new Set(
		timezones.value.map((timezone) => timezone.value),
	);
	const detected = DateTime.local().zoneName ?? "";

	if (detected && knownValues.has(detected)) {
		selectedTimezone.value = detected;
		return;
	}

	if (DEFAULT_TIMEZONE && knownValues.has(DEFAULT_TIMEZONE)) {
		selectedTimezone.value = DEFAULT_TIMEZONE;
	}
}

function notifyFormChanged() {
	const handler = onFormChanged.value;
	handler();
}

function handleTimezoneUpdated(newTimezone: string) {
	selectedTimezone.value = newTimezone;
}

watch([emailEnabled, smsEnabled], () => {
	notifyFormChanged();
	savePendingSmsState();
});

watch(hasPendingSmsChanges, () => {
	savePendingSmsState();
});

function handlePhoneValidityChanged(isValid: boolean) {
	sendVerificationDisabled.value = !isValid;
}

function setupNavigationWarning() {
	if (!hasPendingSmsChanges.value) {
		return;
	}

	function handleBeforeUnload(event: BeforeUnloadEvent) {
		event.preventDefault();
		event.returnValue = "";
		return "";
	}

	window.addEventListener("beforeunload", handleBeforeUnload);

	return () => {
		window.removeEventListener("beforeunload", handleBeforeUnload);
	};
}

onMounted(() => {
	isClient.value = true;
	resolveDefaultTimezone();

	if (user.value.phone_verified && smsEnabled.value) {
		try {
			sessionStorage.removeItem(pendingSmsStorageKey.value);
		} catch (error) {
			rootLogger.warn(
				"Unable to clear session storage for pending SMS changes.",
				{
					storageKey: pendingSmsStorageKey.value,
					error,
				},
			);
		}
	}

	watch(
		() => user.value.phone_verified,
		(isVerified) => {
			if (isVerified) {
				restorePendingSmsState();
			}
		},
		{ immediate: true },
	);

	cleanupNavigationWarning = setupNavigationWarning();
	watch(hasPendingSmsChanges, (hasPending) => {
		if (cleanupNavigationWarning) {
			cleanupNavigationWarning();
		}
		if (hasPending) {
			cleanupNavigationWarning = setupNavigationWarning();
		} else {
			cleanupNavigationWarning = undefined;
		}
	});

	notifyFormChanged();
});

onUnmounted(() => {
	if (cleanupNavigationWarning) {
		cleanupNavigationWarning();
	}
});
</script>
