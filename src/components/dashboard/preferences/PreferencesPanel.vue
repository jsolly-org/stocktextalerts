<template>
	<div
		class="mb-6 bg-white rounded-lg shadow-md border border-gray-200 overflow-hidden"
		data-notification-preferences-card
		:data-form-id="DASHBOARD_FORM_ID"
	>
		<div :class="`h-1 ${CARD_GRADIENT_ACCENTS.primary}`"></div>
		<div class="p-6">
		<h2
			:id="DASHBOARD_SECTION_IDS.preferences"
			class="text-2xl font-bold text-gray-900 mb-2"
		>
			Notification Preferences
		</h2>

		<div v-if="flashMessages.length" class="space-y-2 mb-4">
			<StatusMessage
				v-for="(flash, index) in flashMessages"
				:key="index"
				:tone="flash.tone"
			>
				{{ flash.message }}
			</StatusMessage>
		</div>

		<StatusMessage v-if="timezoneLoadError" tone="warning" class="mb-4">
			Unable to load all timezone options. Only your current timezone is
			available. Please refresh the page to try again.
		</StatusMessage>

		<div class="min-h-5 mb-4">
			<Transition
				enter-active-class="transition-opacity duration-150"
				enter-from-class="opacity-0"
				enter-to-class="opacity-100"
				leave-active-class="transition-opacity duration-150"
				leave-from-class="opacity-100"
				leave-to-class="opacity-0"
			>
				<p
					v-if="statusMessage"
					:id="DASHBOARD_STATUS_ID"
					class="text-sm flex items-center gap-2"
					:class="[statusTone === 'error' ? 'text-error-text' : 'text-info-text']"
					role="status"
					aria-live="polite"
					:aria-busy="isSaving"
					:data-tone="statusTone"
				>
					<ArrowPathIcon
						v-show="isSaving"
						class="animate-spin size-4 shrink-0"
						aria-hidden="true"
					/>
					{{ statusMessage }}
				</p>
			</Transition>
		</div>

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
				@preferences-updated="handlePreferencesUpdated"
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
				:is-sending-verification="isSendingVerification"
				@phone-validity-changed="handlePhoneValidityChanged"
			/>
		</div>
		</div>
	</div>
</template>

<script lang="ts" setup>
import { DateTime } from "luxon";
import { computed, onMounted, onUnmounted, ref, toRefs, watch } from "vue";
// ?component suffix required: Astro Icon cannot be used in Vue; vite-svg-loader compiles this to a Vue component.
import ArrowPathIcon from "../../../icons/arrow-path.svg?component";
import {
	CARD_GRADIENT_ACCENTS,
	DASHBOARD_FORM_ID,
	DASHBOARD_SECTION_IDS,
	DASHBOARD_STATUS_ID,DEFAULT_TIMEZONE 
} from "../../../lib/constants";
import type { User } from "../../../lib/db";
import { rootLogger } from "../../../lib/logging";
import type { TimezoneOption } from "../../../lib/time/cache";
import StatusMessage from "../../StatusMessage.vue";
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
	flashMessages?: { tone: "success" | "error" | "warning"; message: string }[];
	statusMessage?: string | null;
	statusTone?: "error" | "info";
	isSaving?: boolean;
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
	isSendingVerification?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
	timezoneLoadError: false,
	successMessage: null,
	flashMessages: () => [],
	statusMessage: null,
	statusTone: "info",
	isSaving: false,
	isVerifyingCode: false,
	isSendingVerification: false,
});
const {
	emailEnabled: emailEnabledProp,
	smsEnabled: smsEnabledProp,
	isEditingPhone,
	isVerifyingCode,
	isSendingVerification,
	onFormChanged,
	savedPreferences,
	flashMessages,
	statusMessage,
	statusTone,
	isSaving,
	successMessage,
	timezones,
	timezoneLoadError,
	user,
} = toRefs(props);

const emit = defineEmits<{
	(event: "update:emailEnabled", value: boolean): void;
	(event: "update:smsEnabled", value: boolean): void;
	(event: "preferences-updated"): void;
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
	} else if (isEditingPhone.value && pendingSmsState === "true") {
		// Restore pending SMS state when entering change phone mode
		smsEnabled.value = true;
	}
}

function resolveDefaultTimezone() {
	const knownValues = new Set(
		timezones.value.map((timezone) => timezone.value),
	);
	const selectedValue = selectedTimezone.value;
	if (selectedValue && knownValues.has(selectedValue)) {
		return;
	}

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

function handlePreferencesUpdated() {
	emit("preferences-updated");
}

watch([emailEnabled, smsEnabled], () => {
	notifyFormChanged();
});

watch(hasPendingSmsChanges, () => {
	savePendingSmsState();
});

watch(
	[isClient, () => user.value.phone_verified, isEditingPhone],
	([client, isVerified, editingPhone]) => {
		if (client && (isVerified || editingPhone)) {
			restorePendingSmsState();
		}
	},
	{ immediate: true },
);

function handlePhoneValidityChanged(isValid: boolean) {
	sendVerificationDisabled.value = !isValid;
}

function setupNavigationWarning() {
	if (!hasPendingSmsChanges.value) {
		return;
	}

	function handleBeforeUnload(event: BeforeUnloadEvent) {
		// Allow navigation to change_phone=1 without warning
		const allowChangePhone = (window as Window & { __allowChangePhoneNavigation?: boolean }).__allowChangePhoneNavigation;
		if (allowChangePhone) {
			return;
		}
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

	cleanupNavigationWarning = setupNavigationWarning();
});

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

onUnmounted(() => {
	if (cleanupNavigationWarning) {
		cleanupNavigationWarning();
	}
});
</script>
