<template>
	<div
		ref="panelRef"
		class="mb-6 bg-white rounded-lg shadow-sm border border-gray-200 p-6"
		data-notification-preferences-card
		:data-form-id="formId"
	>
		<h2 id="notification-preferences" class="text-2xl font-bold text-gray-900 mb-4">
			Notification Preferences
		</h2>

		<div class="space-y-6">
			<TimezoneSelect
				:id="timezoneSelectId"
				v-model="selectedTimezone"
				:timezones="timezones"
				:disabled="timezoneLoadError"
				@change="emitFormInput"
			/>

			<TimezoneMismatchBanner :is-client="isClient" />

			<NotificationChannelsSection
				v-model:email-enabled="emailEnabled"
				v-model:sms-enabled="smsEnabled"
				:user="user"
				:can-save-sms-enabled="canSaveSmsEnabled"
				:email-notifications-enabled-id="emailNotificationsEnabledId"
				:sms-notifications-enabled-id="smsNotificationsEnabledId"
				:phone-verification-section-id="phoneVerificationSectionId"
				:phone-verification-fieldset-id="phoneVerificationFieldsetId"
				:send-verification-button-id="sendVerificationButtonId"
				:sms-verification-code-id="smsVerificationCodeId"
				:is-editing-phone="isEditingPhone"
				:send-verification-disabled="sendVerificationDisabled"
				:success-message="successMessage"
				@phone-validity-changed="handlePhoneValidityChanged"
			/>
		</div>
	</div>
</template>

<script lang="ts" setup>
import { DateTime } from "luxon";
import { computed, nextTick, onMounted, ref, toRefs, watch } from "vue";

import type { User } from "../../../lib/db";
import { findFormElement } from "../../../lib/forms/dom/form-discovery";
import { setupTimezoneMismatchBanner } from "../../../lib/time/banner";
import type { TimezoneOption } from "../../../lib/time/cache";
import { DEFAULT_TIMEZONE } from "../../../lib/time/constants";
import NotificationChannelsSection from "./NotificationChannelsSection.vue";
import TimezoneMismatchBanner from "./TimezoneMismatchBanner.vue";
import TimezoneSelect from "./TimezoneSelect.vue";

interface Props {
	user: User;
	timezones: TimezoneOption[];
	isEditingPhone: boolean;
	formId: string;
	emailEnabled: boolean;
	smsEnabled: boolean;
	timezoneLoadError?: boolean;
	successMessage?: string | null;
}

const props = withDefaults(defineProps<Props>(), {
	timezoneLoadError: false,
	successMessage: null,
});
const { emailEnabled: emailEnabledProp, formId, isEditingPhone, successMessage, timezones, timezoneLoadError, user, smsEnabled: smsEnabledProp } =
	toRefs(props);

const emit = defineEmits<{
	(event: "update:emailEnabled", value: boolean): void;
	(event: "update:smsEnabled", value: boolean): void;
}>();

const panelRef = ref<HTMLElement | null>(null);
const formElement = ref<HTMLFormElement | null>(null);
const sendVerificationDisabled = ref(true);
const isClient = ref(false);

const timezoneSelectId = computed(() => `${formId.value}-timezone`);
const emailNotificationsEnabledId = computed(
	() => `${formId.value}-email_notifications_enabled`,
);
const smsNotificationsEnabledId = computed(
	() => `${formId.value}-sms_notifications_enabled`,
);
const phoneVerificationSectionId = computed(
	() => `${formId.value}-phone-verification-section`,
);
const phoneVerificationFieldsetId = computed(
	() => `${formId.value}-phone-verification-fieldset`,
);
const sendVerificationButtonId = computed(
	() => `${formId.value}-send-verification-button`,
);
const smsVerificationCodeId = computed(
	() => `${formId.value}-sms-verification-code`,
);

const PENDING_SMS_STORAGE_KEY = "pending_sms_enabled";

const emailEnabled = computed({
	get: () => emailEnabledProp.value,
	set: (value: boolean) => emit("update:emailEnabled", value),
});
const smsEnabled = computed({
	get: () => smsEnabledProp.value,
	set: (value: boolean) => emit("update:smsEnabled", value),
});
const selectedTimezone = ref(user.value.timezone ?? "");

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
	if (hasPendingSmsChanges.value) {
		sessionStorage.setItem(PENDING_SMS_STORAGE_KEY, "true");
	} else {
		sessionStorage.removeItem(PENDING_SMS_STORAGE_KEY);
	}
}

function restorePendingSmsState() {
	if (user.value.phone_verified && sessionStorage.getItem(PENDING_SMS_STORAGE_KEY) === "true") {
		smsEnabled.value = true;
		sessionStorage.removeItem(PENDING_SMS_STORAGE_KEY);
		emitFormInput();
	}
}

function resolveDefaultTimezone() {
	if (selectedTimezone.value !== "") {
		return;
	}

	const knownValues = new Set(timezones.value.map((timezone) => timezone.value));
	const detected = DateTime.local().zoneName ?? "";

	if (detected && knownValues.has(detected)) {
		selectedTimezone.value = detected;
		return;
	}

	if (DEFAULT_TIMEZONE && knownValues.has(DEFAULT_TIMEZONE)) {
		selectedTimezone.value = DEFAULT_TIMEZONE;
	}
}

function emitFormInput() {
	formElement.value?.dispatchEvent(new Event("input", { bubbles: true }));
}

function syncChannelState() {
	emitFormInput();
}

watch([emailEnabled, smsEnabled], () => {
	syncChannelState();
	savePendingSmsState();
});

watch(hasPendingSmsChanges, () => {
	savePendingSmsState();
});

const handlePhoneValidityChanged = (isValid: boolean) => {
	sendVerificationDisabled.value = !isValid;
};

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
	formElement.value = findFormElement({
		formId: formId.value,
		fallbackElement: panelRef.value,
	});

	resolveDefaultTimezone();

	restorePendingSmsState();

	if (!formElement.value) {
		return;
	}

	if (user.value.phone_verified && smsEnabled.value) {
		sessionStorage.removeItem(PENDING_SMS_STORAGE_KEY);
	}

	watch(
		() => user.value.phone_verified,
		(isVerified) => {
			if (isVerified && sessionStorage.getItem(PENDING_SMS_STORAGE_KEY) === "true") {
				restorePendingSmsState();
			}
		},
	);

	let cleanupNavigationWarning = setupNavigationWarning();
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

	syncChannelState();

	nextTick(() => {
		setupTimezoneMismatchBanner({
			savedTimezone: user.value.timezone ?? "",
			allowedTimezones: timezones.value.map((timezone) => timezone.value),
			dismissTimezoneMismatchPrompts:
				user.value.dismiss_timezone_mismatch_prompts ?? false,
		});
	});
});

</script>
