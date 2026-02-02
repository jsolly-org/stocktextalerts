<template>
	<section
		class="card relative mb-6"
		data-notification-channels-card
		:data-form-id="DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID"
	>
		<Transition
			enter-active-class="transition-opacity duration-150"
			enter-from-class="opacity-0"
			enter-to-class="opacity-100"
			leave-active-class="transition-opacity duration-150"
			leave-from-class="opacity-100"
			leave-to-class="opacity-0"
		>
			<div
				v-if="statusMessage"
				:id="DASHBOARD_NOTIFICATION_PREFERENCES_STATUS_ID"
				class="absolute top-3 right-3 flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium z-10"
				:class="[statusTone === 'error' ? 'bg-error-bg text-error-text' : 'bg-info-bg text-info-text']"
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
		</Transition>

		<div :class="`h-1 ${CARD_GRADIENT_ACCENTS.primary}`"></div>
		<div class="card-body" :id="DASHBOARD_SECTION_IDS.notificationChannels">

		<div v-if="flashMessages.length" class="space-y-2 mb-4">
			<StatusMessage
				v-for="(flash, index) in flashMessages"
				:key="index"
				:tone="flash.tone"
			>
				{{ flash.message }}
			</StatusMessage>
		</div>

		<section :id="DASHBOARD_SECTION_IDS.notificationChannels" class="space-y-4">
			<header>
				<h2 class="text-xl sm:text-2xl font-bold text-gray-900">
					Notification Channels
				</h2>
				<p :id="notificationChannelsDescId" class="text-sm text-gray-600 mt-1.5">
					Choose how you want to receive alerts.
				</p>
			</header>
			<fieldset
				class="rounded-lg border border-gray-200 divide-y divide-gray-200"
				:aria-describedby="notificationChannelsDescId"
			>
				<legend class="sr-only">Notification channels</legend>
				<label class="flex items-start gap-3 p-4 cursor-pointer transition-colors hover:bg-gray-50 focus-within:bg-gray-50">
					<input
						type="hidden"
						name="email_notifications_enabled"
						:value="emailEnabled ? 'on' : 'off'"
					/>
					<input
						type="checkbox"
						:id="emailNotificationsEnabledId"
						class="mt-0.5 h-6 w-6 rounded cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
						v-model="emailEnabled"
					/>
					<span class="text-sm">
						<span class="font-medium text-gray-900">Email Notifications</span>
						<span class="block text-gray-500">
							Notifications are sent to your registered email.
						</span>
					</span>
				</label>

				<div>
					<label class="flex items-start gap-3 p-4 cursor-pointer transition-colors hover:bg-gray-50 focus-within:bg-gray-50">
						<input
							v-if="canSaveSmsEnabled"
							type="hidden"
							name="sms_notifications_enabled"
							:value="smsEnabled ? 'on' : 'off'"
						/>
						<input
							type="checkbox"
							:id="smsNotificationsEnabledId"
							class="mt-0.5 h-6 w-6 rounded cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
							v-model="smsEnabled"
						/>
						<span class="text-sm">
							<span class="font-medium text-gray-900">SMS Notifications</span>
							<span class="block text-gray-500">
								Notifications will be sent to a phone number you provide.
							</span>
						</span>
					</label>

					<SmsVerificationSection
						:user="user"
						:sms-enabled="smsEnabled"
						:is-editing-phone="isEditingPhone"
						:success-message="successMessage"
						:send-verification-disabled="sendVerificationDisabled"
						:is-verifying-code="isVerifyingCode"
						:is-sending-verification="isSendingVerification"
						@phone-validity-changed="handlePhoneValidityChanged"
						@phone-editing-changed="handlePhoneEditingChanged"
					/>
				</div>
			</fieldset>

			<StatusMessage v-if="showTimeReminder" tone="warning">
				Choose a
				<button
					type="button"
					class="underline rounded cursor-pointer hover:text-warning-text/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning focus-visible:ring-offset-2"
					@click="scrollToScheduled"
				>
					delivery time
				</button>
				to start sending your daily digest.
			</StatusMessage>

		</section>
		</div>
	</section>
</template>

<script lang="ts" setup>
import { computed, onMounted, onUnmounted, ref, toRefs, watch } from "vue";
// ?component suffix required: Astro Icon cannot be used in Vue; vite-svg-loader compiles this to a Vue component.
import ArrowPathIcon from "../../../icons/arrow-path.svg?component";
import {
	CARD_GRADIENT_ACCENTS,
	DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID,
	DASHBOARD_NOTIFICATION_PREFERENCES_STATUS_ID,
	DASHBOARD_SECTION_IDS,
	type FlashMessage,
} from "../../../lib/constants";
import type { User } from "../../../lib/db";
import { rootLogger } from "../../../lib/logging";
import StatusMessage from "../../StatusMessage.vue";
import SmsVerificationSection from "./SmsVerificationSection.vue";

interface Props {
	user: User;
	isEditingPhone: boolean;
	emailEnabled: boolean;
	smsEnabled: boolean;
	onFormChanged: () => void;
	successMessage?: string | null;
	flashMessages?: FlashMessage[];
	statusMessage?: string | null;
	statusTone?: "error" | "info";
	isSaving?: boolean;
	isVerifyingCode?: boolean;
	isSendingVerification?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
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
	flashMessages,
	statusMessage,
	statusTone,
	isSaving,
	successMessage,
	user,
} = toRefs(props);

const emit = defineEmits<{
	(event: "update:emailEnabled", value: boolean): void;
	(event: "update:smsEnabled", value: boolean): void;
	(event: "notification-preferences-updated"): void;
	(event: "phone-editing-changed", value: boolean): void;
}>();

const sendVerificationDisabled = ref(true);
let cleanupNavigationWarning: (() => void) | undefined;

const PENDING_SMS_STORAGE_KEY = "pending_sms_enabled";

const pendingSmsStorageKey = computed(() => {
	return `${PENDING_SMS_STORAGE_KEY}:${user.value.id}`;
});
const emailNotificationsEnabledId = `${DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID}-email_notifications_enabled`;
const smsNotificationsEnabledId = `${DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID}-sms_notifications_enabled`;
const notificationChannelsDescId = `${DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID}-notification-channels-desc`;

const emailEnabled = computed({
	get: () => emailEnabledProp.value,
	set: (value: boolean) => emit("update:emailEnabled", value),
});
const smsEnabled = computed({
	get: () => smsEnabledProp.value,
	set: (value: boolean) => emit("update:smsEnabled", value),
});
const canSaveSmsEnabled = computed(() => {
	if (!smsEnabled.value) {
		return true;
	}
	return user.value.phone_verified === true;
});
const showTimeReminder = computed(() => {
	if (!emailEnabled.value && !smsEnabled.value) {
		return false;
	}
	if (!user.value.daily_digest_enabled) {
		return false;
	}
		const times = user.value.daily_digest_notification_times;
		return !times || times.length === 0;
});

const hasPendingSmsChanges = computed(() => {
	return smsEnabled.value && !user.value.phone_verified;
});

function savePendingSmsState() {
	if (typeof window === "undefined") return;
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
	if (typeof window === "undefined") return;
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

function notifyFormChanged() {
	const handler = onFormChanged.value;
	handler();
}

function handleNotificationPreferencesUpdated() {
	emit("notification-preferences-updated");
}

watch([emailEnabled, smsEnabled], () => {
	notifyFormChanged();
});

watch(hasPendingSmsChanges, () => {
	savePendingSmsState();
});

watch(
	[() => user.value.phone_verified, isEditingPhone],
	([isVerified, editingPhone]) => {
		if (isVerified || editingPhone) {
			restorePendingSmsState();
		}
	},
	{ immediate: true },
);

function handlePhoneValidityChanged(isValid: boolean) {
	sendVerificationDisabled.value = !isValid;
}

function handlePhoneEditingChanged(value: boolean) {
	emit("phone-editing-changed", value);
}

function scrollToScheduled() {
	const el = document.getElementById(DASHBOARD_SECTION_IDS.scheduled);
	if (el) {
		el.scrollIntoView({ behavior: "smooth" });
	}
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
