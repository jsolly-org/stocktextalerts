<template>
	<div class="space-y-3">
		<div>
			<h2 class="text-2xl font-bold text-gray-900">
				Notification Channels
			</h2>
			<p class="text-sm text-gray-600 mt-1">
				Choose how you want to receive alerts.
			</p>
		</div>
		<div class="rounded-md border border-gray-200 divide-y divide-gray-200">
			<label class="flex items-start gap-3 p-3 cursor-pointer">
				<input
					type="hidden"
					name="email_notifications_enabled"
					:value="emailEnabledValue ? 'on' : 'off'"
				/>
				<input
					type="checkbox"
					:id="emailNotificationsEnabledId"
					class="mt-0.5 h-5 w-5 cursor-pointer"
					v-model="emailEnabledValue"
				/>
				<span class="text-sm">
					<span class="font-medium text-gray-900">Email Notifications</span>
					<span class="block text-gray-500">
						Notifications are sent to your registered email.
					</span>
				</span>
			</label>

			<label class="flex items-start gap-3 p-3 cursor-pointer">
				<input
					v-if="canSaveSmsEnabled"
					type="hidden"
					name="sms_notifications_enabled"
					:value="smsEnabledValue ? 'on' : 'off'"
				/>
				<input
					type="checkbox"
					:id="smsNotificationsEnabledId"
					class="mt-0.5 h-5 w-5 cursor-pointer"
					v-model="smsEnabledValue"
				/>
				<span class="text-sm">
					<span class="font-medium text-gray-900">SMS Notifications</span>
					<span class="block text-gray-500">
						Notifications will be sent to a phone number you provide.
					</span>
				</span>
			</label>
		</div>

		<StatusMessage v-if="user.sms_opted_out" tone="error">
			You have opted out of SMS notifications. To re-enable, reply START to any
			message from us or update your notification settings in your account.
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
