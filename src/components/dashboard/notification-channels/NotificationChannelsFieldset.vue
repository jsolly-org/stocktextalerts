<template>
	<section :id="DASHBOARD_SECTION_IDS.notificationChannels" class="space-y-4">
		<header>
			<h2 class="text-xl sm:text-2xl font-bold text-gray-900">
				Notification Channels
			</h2>
			<p :id="props.notificationChannelsDescId" class="text-sm text-gray-600 mt-1.5">
				Choose how you want to receive alerts.
			</p>
		</header>

		<fieldset
			class="rounded-lg border border-gray-200 divide-y divide-gray-200"
			:aria-describedby="props.notificationChannelsDescId"
		>
			<legend class="sr-only">Notification channels</legend>

			<div class="flex items-center justify-between gap-3 p-4">
				<input
					type="hidden"
					name="email_notifications_enabled"
					:value="emailEnabled ? 'on' : 'off'"
				/>
				<div>
					<span :id="`${props.emailNotificationsEnabledId}_label`" class="text-sm font-medium text-gray-900">Email Notifications</span>
					<span :id="`${props.emailNotificationsEnabledId}_desc`" class="block text-sm text-gray-500">
						Notifications are sent to your registered email.
					</span>
				</div>
				<ToggleSwitch
					v-model="emailEnabled"
					sr-label="Email notifications"
					:aria-labelledby="`${props.emailNotificationsEnabledId}_label`"
					:aria-describedby="`${props.emailNotificationsEnabledId}_desc`"
				/>
			</div>

			<div>
				<div class="flex items-center justify-between gap-3 p-4">
					<input
						v-if="props.canSaveSmsEnabled"
						type="hidden"
						name="sms_notifications_enabled"
						:value="smsEnabled ? 'on' : 'off'"
					/>
					<div>
						<span :id="`${props.smsNotificationsEnabledId}_label`" class="text-sm font-medium text-gray-900">SMS Notifications</span>
						<span :id="`${props.smsNotificationsEnabledId}_desc`" class="block text-sm text-gray-500">
							Notifications will be sent to a phone number you provide.
						</span>
					</div>
					<ToggleSwitch
						v-model="smsEnabled"
						sr-label="SMS notifications"
						:aria-labelledby="`${props.smsNotificationsEnabledId}_label`"
						:aria-describedby="`${props.smsNotificationsEnabledId}_desc`"
					/>
				</div>

				<SmsVerificationSection
					:user="props.user"
					:sms-enabled="smsEnabled"
					:is-editing-phone="props.isEditingPhone"
					:success-message="props.successMessage"
					:send-verification-disabled="props.sendVerificationDisabled"
					:is-verifying-code="props.isVerifyingCode"
					:is-sending-verification="props.isSendingVerification"
					@phone-validity-changed="(value) => emit('phone-validity-changed', value)"
					@phone-editing-changed="(value) => emit('phone-editing-changed', value)"
				/>
			</div>
		</fieldset>

		<StatusMessage v-if="props.showTimeReminder" tone="warning">
			Choose a
			<button
				type="button"
				class="underline rounded cursor-pointer hover:text-warning-text/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning focus-visible:ring-offset-2"
				@click="emit('scroll-to-scheduled')"
			>
				delivery time
			</button>
			to start sending your updates.
		</StatusMessage>
	</section>
</template>

<script lang="ts" setup>
import { computed } from "vue";
import { DASHBOARD_SECTION_IDS } from "../../../lib/constants";
import type { User } from "../../../lib/db";
import StatusMessage from "../../StatusMessage.vue";
import ToggleSwitch from "../../ToggleSwitch.vue";
import SmsVerificationSection from "./SmsVerificationSection.vue";

interface Props {
	user: User;
	emailEnabled: boolean;
	smsEnabled: boolean;
	isEditingPhone: boolean;
	successMessage?: string | null;
	sendVerificationDisabled: boolean;
	isVerifyingCode?: boolean;
	isSendingVerification?: boolean;
	canSaveSmsEnabled: boolean;
	showTimeReminder: boolean;
	emailNotificationsEnabledId: string;
	smsNotificationsEnabledId: string;
	notificationChannelsDescId: string;
}

const props = withDefaults(defineProps<Props>(), {
	successMessage: null,
	isVerifyingCode: false,
	isSendingVerification: false,
});

const emit = defineEmits<{
	(event: "update:emailEnabled", value: boolean): void;
	(event: "update:smsEnabled", value: boolean): void;
	(event: "phone-validity-changed", value: boolean): void;
	(event: "phone-editing-changed", value: boolean): void;
	(event: "scroll-to-scheduled"): void;
}>();

const emailEnabled = computed({
	get: () => props.emailEnabled,
	set: (value: boolean) => emit("update:emailEnabled", value),
});
const smsEnabled = computed({
	get: () => props.smsEnabled,
	set: (value: boolean) => emit("update:smsEnabled", value),
});
</script>
