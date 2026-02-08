<template>
	<form
		ref="notificationPreferencesFormElement"
		:id="DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID"
		method="POST"
		action="/api/notification-preferences/update"
		class="space-y-6"
		aria-label="Notification preferences"
		:aria-busy="isSaving"
		@input="handleFormInput"
		@change="handleFormChange"
		@submit="handleFormSubmitWrapper"
	>
		<section
			class="card relative mb-6"
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

			<div :class="`h-1 ${CARD_GRADIENT_ACCENTS.primary}`"></div>
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
				v-model:emailEnabled="emailEnabled"
				v-model:smsEnabled="smsEnabled"
				:can-save-sms-enabled="canSaveSmsEnabled"
				:sms-opted-out="smsOptedOut"
				:show-time-reminder="showTimeReminder"
				:email-notifications-enabled-id="emailNotificationsEnabledId"
				:sms-notifications-enabled-id="smsNotificationsEnabledId"
				:notification-channels-desc-id="notificationChannelsDescId"
				@scroll-to-scheduled="scrollToScheduled"
			/>
			</div>
		</section>
	</form>
</template>

<script lang="ts" setup>
import { computed, ref, toRefs, watch } from "vue";
// ?component suffix required: Astro Icon cannot be used in Vue; vite-svg-loader compiles this to a Vue component.
import ArrowPathIcon from "../../../icons/arrow-path.svg?component";
import {
	CARD_GRADIENT_ACCENTS,
	DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID,
	DASHBOARD_NOTIFICATION_PREFERENCES_STATUS_ID,
	DASHBOARD_SECTION_IDS,
	type FlashMessage,
	type FlashTone,
	formatMessage,
	STATUS_TONE_CLASSES,
} from "../../../lib/constants";
import { rootLogger } from "../../../lib/logging";
import { fetchCurrentNotificationPreferences } from "../../../lib/notification-preferences/client";
import FadeTransition from "../../FadeTransition.vue";
import StatusMessage from "../../StatusMessage.vue";
import {
	type NotificationPreferencesData,
	useAutoSaveForm,
} from "../composables/useAutoSaveNotificationPreferences";
import { useDashboardUser } from "../composables/useDashboardUser";
import { provideSmsVerificationContext } from "../composables/useSmsVerificationContext";
import { useSmsVerificationSubmission } from "../composables/useSmsVerificationSubmission";
import NotificationChannelsFieldset from "./NotificationChannelsFieldset.vue";
import { usePendingSmsChanges } from "./pending-sms-changes";

interface Props {
	emailEnabled: boolean;
	smsEnabled: boolean;
}

const props = defineProps<Props>();
const {
	emailEnabled: emailEnabledProp,
	smsEnabled: smsEnabledProp,
} = toRefs(props);

const emit = defineEmits<{
	(event: "update:emailEnabled", value: boolean): void;
	(event: "update:smsEnabled", value: boolean): void;
}>();

// Inject the shared mutable user ref from DashboardPanels
const user = useDashboardUser();

// Track server state separately so we can preserve a user's pending SMS toggle until it's persisted.
const serverSmsEnabled = ref(user.value.sms_notifications_enabled);
watch(
	() => user.value.sms_notifications_enabled,
	(value) => {
		serverSmsEnabled.value = value;
	},
);

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

const phoneVerified = computed(() => user.value.phone_verified === true);
const smsOptedOut = computed(() => user.value.sms_opted_out === true);

const canSaveSmsEnabled = computed(() => {
	if (!smsEnabled.value) {
		return true;
	}
	return phoneVerified.value;
});
const showTimeReminder = computed(() => {
	if (!emailEnabled.value && !smsEnabled.value) {
		return false;
	}
	const times = user.value.scheduled_update_times;
	return !times || times.length === 0;
});

// Notify auto-save when channel toggles change
watch([emailEnabled, smsEnabled], () => {
	notifyChange();
});

// Watch savedData and update shared user ref directly (no more event bubbling)
watch(
	() => savedNotificationPreferencesData.value,
	(newData) => {
		if (newData) {
			serverSmsEnabled.value = newData.sms_notifications_enabled;

			// Update shared user ref directly
			user.value = {
				...user.value,
				email_notifications_enabled: newData.email_notifications_enabled,
				sms_notifications_enabled: newData.sms_notifications_enabled,
				sms_opted_out: newData.sms_opted_out,
				phone_verified: newData.phone_verified,
			};
			// Sync channel state with parent
			emit("update:emailEnabled", newData.email_notifications_enabled);

			// Preserve a user's SMS toggle if it's "on" but not persisted yet.
			// This happens when SMS was enabled while the phone was unverified; the server
			// will still report sms_notifications_enabled=false until we can save it.
			const shouldPreserveSmsEnabled =
				smsEnabled.value && !newData.sms_notifications_enabled;
			if (!shouldPreserveSmsEnabled) {
				emit("update:smsEnabled", newData.sms_notifications_enabled);
			}
		}
	},
);

function scrollToScheduled() {
	const el = document.getElementById(DASHBOARD_SECTION_IDS.scheduled);
	if (el) {
		el.scrollIntoView({ behavior: "smooth" });
	}
}

/* ============= Pending SMS changes ============= */
usePendingSmsChanges({
	userId: computed(() => user.value.id),
	smsEnabled,
	phoneVerified,
	serverSmsEnabled,
	isEditingPhone,
	logger: rootLogger,
});

// When phone becomes verified: exit phone-edit mode
watch(phoneVerified, (isVerified) => {
	if (isVerified) {
		isEditingPhone.value = false;

		// If the user enabled SMS before verification, persist that preference now that
		// we can safely include sms_notifications_enabled in the form payload.
		if (smsEnabled.value && !serverSmsEnabled.value) {
			notifyChange();
		}
	}
});
</script>
