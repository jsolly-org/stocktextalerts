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
		</Transition>

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
			:user="user"
			:is-editing-phone="isEditingPhone"
			:success-message="successMessage"
			:send-verification-disabled="sendVerificationDisabled"
			:is-verifying-code="isVerifyingCode"
			:is-sending-verification="isSendingVerification"
			:can-save-sms-enabled="canSaveSmsEnabled"
			:show-time-reminder="showTimeReminder"
			:email-notifications-enabled-id="emailNotificationsEnabledId"
			:sms-notifications-enabled-id="smsNotificationsEnabledId"
			:notification-channels-desc-id="notificationChannelsDescId"
			@phone-validity-changed="handlePhoneValidityChanged"
			@phone-editing-changed="handlePhoneEditingChanged"
			@scroll-to-scheduled="scrollToScheduled"
		/>
		</div>
	</section>
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
	STATUS_TONE_CLASSES,
	type StatusTone,
} from "../../../lib/constants";
import type { User } from "../../../lib/db";
import { rootLogger } from "../../../lib/logging";
import StatusMessage from "../../StatusMessage.vue";
import NotificationChannelsFieldset from "./NotificationChannelsFieldset.vue";
import { usePendingSmsChanges } from "./pending-sms-changes";

interface Props {
	user: User;
	isEditingPhone: boolean;
	emailEnabled: boolean;
	smsEnabled: boolean;
	onFormChanged: () => void;
	successMessage?: string | null;
	flashMessages?: FlashMessage[];
	statusMessage?: string | null;
	statusTone?: StatusTone;
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
	(event: "phone-editing-changed", value: boolean): void;
}>();

const sendVerificationDisabled = ref(true);
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
	if (!user.value.scheduled_updates_enabled) {
		return false;
	}
	const times = user.value.scheduled_update_times;
	return !times || times.length === 0;
});

function notifyFormChanged() {
	const handler = onFormChanged.value;
	handler();
}

watch([emailEnabled, smsEnabled], () => {
	notifyFormChanged();
});

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

usePendingSmsChanges({
	userId: computed(() => user.value.id),
	smsEnabled,
	phoneVerified,
	isEditingPhone,
	logger: rootLogger,
});
</script>
