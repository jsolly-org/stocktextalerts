<template>
	<div class="space-y-4">
		<label class="block text-sm font-medium text-gray-700 mb-2">
			Notification Channels
		</label>
		<div class="space-y-4">
			<label class="flex items-center cursor-pointer">
				<input
					type="hidden"
					name="email_notifications_enabled"
					:value="emailEnabledValue ? 'on' : 'off'"
				/>
				<input
					type="checkbox"
					:id="emailNotificationsEnabledId"
					class="mr-2 cursor-pointer"
					v-model="emailEnabledValue"
				/>
				<span>Email Notifications</span>
			</label>

			<label class="flex items-center cursor-pointer">
				<input
					v-if="canSaveSmsEnabled"
					type="hidden"
					name="sms_notifications_enabled"
					:value="smsEnabledValue ? 'on' : 'off'"
				/>
				<input
					type="checkbox"
					:id="smsNotificationsEnabledId"
					class="mr-2 cursor-pointer"
					v-model="smsEnabledValue"
				/>
				<span>SMS Notifications</span>
			</label>

			<StatusMessage v-if="user.sms_opted_out" tone="error" class="ml-6">
				You have opted out of SMS notifications. To re-enable, reply START to
				any message from us or update your settings below.
			</StatusMessage>

			<SmsVerificationSection
				v-if="!user.sms_opted_out"
				:user="user"
				:sms-enabled="smsEnabledValue"
				:is-editing-phone="isEditingPhone"
				:success-message="successMessage"
				:send-verification-disabled="sendVerificationDisabled"
				:is-verifying-code="isVerifyingCode"
				:is-sending-verification="isSendingVerification"
				@phone-validity-changed="handlePhoneValidityChanged"
			/>
		</div>
	</div>
</template>

<script lang="ts" setup>
import { computed } from "vue";
import { DASHBOARD_FORM_ID } from "../../../lib/constants";
import type { User } from "../../../lib/db";
import StatusMessage from "../../StatusMessage.vue";
import SmsVerificationSection from "./SmsVerificationSection.vue";

interface Props {
	user: User;
	emailEnabled: boolean;
	smsEnabled: boolean;
	canSaveSmsEnabled: boolean;
	isEditingPhone: boolean;
	sendVerificationDisabled: boolean;
	successMessage?: string | null;
	isVerifyingCode?: boolean;
	isSendingVerification?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
	successMessage: null,
});

const emit = defineEmits<{
	(event: "update:emailEnabled", value: boolean): void;
	(event: "update:smsEnabled", value: boolean): void;
	(event: "phone-validity-changed", value: boolean): void;
}>();

const emailEnabledValue = computed({
	get: () => props.emailEnabled,
	set: (value: boolean) => emit("update:emailEnabled", value),
});

const smsEnabledValue = computed({
	get: () => props.smsEnabled,
	set: (value: boolean) => emit("update:smsEnabled", value),
});

const emailNotificationsEnabledId = `${DASHBOARD_FORM_ID}-email_notifications_enabled`;
const smsNotificationsEnabledId = `${DASHBOARD_FORM_ID}-sms_notifications_enabled`;

function handlePhoneValidityChanged(isValid: boolean) {
	emit("phone-validity-changed", isValid);
}
</script>
