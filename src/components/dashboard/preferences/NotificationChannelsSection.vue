<template>
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
					:value="emailEnabledValue ? 'on' : 'off'"
				/>
				<input
					type="checkbox"
					:id="emailNotificationsEnabledId"
					class="mt-0.5 h-6 w-6 rounded cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
					v-model="emailEnabledValue"
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
						:value="smsEnabledValue ? 'on' : 'off'"
					/>
					<input
						type="checkbox"
						:id="smsNotificationsEnabledId"
						class="mt-0.5 h-6 w-6 rounded cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
						v-model="smsEnabledValue"
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
					:sms-enabled="smsEnabledValue"
					:is-editing-phone="isEditingPhone"
					:success-message="successMessage"
					:send-verification-disabled="sendVerificationDisabled"
					:is-verifying-code="isVerifyingCode"
					:is-sending-verification="isSendingVerification"
					@phone-validity-changed="emit('phone-validity-changed', $event)"
					@phone-editing-changed="emit('phone-editing-changed', $event)"
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
</template>

<script lang="ts" setup>
import { computed } from "vue";
import {
	DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID,
	DASHBOARD_SECTION_IDS,
} from "../../../lib/constants";
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
	showTimeReminder: boolean;
}

const props = withDefaults(defineProps<Props>(), {
	successMessage: null,
});

const emit = defineEmits<{
	(event: "update:emailEnabled", value: boolean): void;
	(event: "update:smsEnabled", value: boolean): void;
	(event: "phone-validity-changed", value: boolean): void;
	(event: "phone-editing-changed", value: boolean): void;
}>();

const emailEnabledValue = computed({
	get: () => props.emailEnabled,
	set: (value: boolean) => emit("update:emailEnabled", value),
});

const smsEnabledValue = computed({
	get: () => props.smsEnabled,
	set: (value: boolean) => emit("update:smsEnabled", value),
});

const emailNotificationsEnabledId = `${DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID}-email_notifications_enabled`;
const smsNotificationsEnabledId = `${DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID}-sms_notifications_enabled`;
const notificationChannelsDescId = `${DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID}-notification-channels-desc`;

function scrollToScheduled() {
	const el = document.getElementById(DASHBOARD_SECTION_IDS.scheduled);
	if (el) {
		el.scrollIntoView({ behavior: "smooth" });
	}
}
</script>
