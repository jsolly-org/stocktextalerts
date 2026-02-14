<template>
	<section :id="DASHBOARD_SECTION_IDS.notificationChannels" class="space-y-4">
		<header>
			<h2 class="text-xl sm:text-2xl font-bold text-heading">
				Notification Channels
			</h2>
			<p :id="props.notificationChannelsDescId" class="text-sm text-body-secondary mt-1.5">
				Choose how you want to receive alerts.
			</p>
		</header>

		<fieldset
			class="divide-y divide-edge"
			:disabled="props.isSaving"
			:aria-describedby="props.notificationChannelsDescId"
		>
			<legend class="sr-only">Notification channels</legend>

			<div class="flex items-center justify-between gap-3 py-4">
				<input
					type="hidden"
					name="email_notifications_enabled"
					:value="emailEnabled ? 'on' : 'off'"
				/>
				<div>
					<span :id="`${props.emailNotificationsEnabledId}_label`" class="text-sm font-medium text-heading">Email Notifications</span>
					<span :id="`${props.emailNotificationsEnabledId}_desc`" class="block text-sm text-muted">
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
			<div class="flex items-center justify-between gap-3 py-4">
				<input
					v-if="props.canSaveSmsEnabled"
					type="hidden"
					name="sms_notifications_enabled"
						:value="smsEnabled ? 'on' : 'off'"
					/>
					<div>
						<span :id="`${props.smsNotificationsEnabledId}_label`" class="text-sm font-medium text-heading">SMS Notifications</span>
						<span :id="`${props.smsNotificationsEnabledId}_desc`" class="block text-sm text-muted">
							Notifications will be sent to a phone number you provide.
						</span>
					</div>
					<ToggleSwitch
						v-model="smsEnabled"
						sr-label="SMS notifications"
						:disabled="props.smsOptedOut"
						:aria-labelledby="`${props.smsNotificationsEnabledId}_label`"
						:aria-describedby="`${props.smsNotificationsEnabledId}_desc`"
					/>
				</div>

				<StatusMessage v-if="props.smsOptedOut" tone="warning" class="mb-4">
					<span>You've opted out of SMS notifications. To re-enable:</span>
					<ol class="list-decimal list-inside mt-1 space-y-0.5">
						<li>Text <strong>START</strong> to <a v-if="props.smsPhoneNumber" :href="`sms:${props.smsPhoneNumber}`" class="link-action font-medium">{{ props.smsPhoneNumber }}</a><span v-else>our SMS number</span></li>
						<li>Return here and turn SMS back on</li>
					</ol>
				</StatusMessage>

				<SmsVerificationSection
					:sms-enabled="smsEnabled"
					:sms-opted-out="props.smsOptedOut"
				/>
			</div>
		</fieldset>

		<div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 pt-2">
			<div class="min-w-0">
				<span
					id="daily_digest_time_label"
					class="text-base font-semibold text-heading"
				>
					Daily digest delivery time
				</span>
				<p
					id="daily_digest_time_description"
					class="text-sm text-body-secondary mt-0.5"
				>
					Controls when your <a :href="DASHBOARD_SECTION_HASHES.dailyNotifications" class="font-medium text-primary underline rounded-sm hover:text-primary-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1">Daily Digest</a> is sent each day (if enabled).
				</p>
			</div>
			<div class="sm:shrink-0">
				<div class="flex flex-col sm:flex-row sm:items-center gap-2">
					<TimePicker
						:inputId="`daily_digest_time`"
						:inputName="`daily_digest_time`"
						:initialTime="props.dailyDeliveryTimeInput"
						inputAriaLabel="Daily digest delivery time"
						:disabled="!hasNotificationChannel"
						:clearable="props.dailyDeliveryTimeMinutes !== null && hasNotificationChannel"
						clearAriaLabel="Clear delivery time"
						:is24="props.is24"
						@time-change="emit('dailyTimeChange', $event)"
						@clear="emit('clearDeliveryTime')"
					/>
					<button
						v-if="props.marketOpenLabel"
						type="button"
						class="btn btn-md btn-secondary h-[41px] shrink-0 whitespace-nowrap"
						:disabled="!canSetMarketOpen"
						:aria-label="`Set delivery time to US market open (${props.marketOpenLabel})`"
						@click="emit('setMarketOpen')"
					>
						<PresentationChartLineIcon class="size-4 shrink-0" aria-hidden="true" />
						Market open
					</button>
				</div>
			</div>
		</div>

	</section>
</template>

<script lang="ts" setup>
import { computed } from "vue";
import PresentationChartLineIcon from "../../../icons/presentation-chart-line.svg?component";
import { DASHBOARD_SECTION_HASHES, DASHBOARD_SECTION_IDS } from "../../../lib/constants";
import StatusMessage from "../../StatusMessage.vue";
import ToggleSwitch from "../../ToggleSwitch.vue";
import TimePicker from "../shared/TimePicker.vue";
import SmsVerificationSection from "./SmsVerificationSection.vue";

interface Props {
	emailEnabled: boolean;
	smsEnabled: boolean;
	phoneVerified: boolean;
	canSaveSmsEnabled: boolean;
	smsOptedOut: boolean;
	smsPhoneNumber: string;
	emailNotificationsEnabledId: string;
	smsNotificationsEnabledId: string;
	notificationChannelsDescId: string;
	isSaving?: boolean;
	/** Current daily delivery time as an HH:MM string, or null. */
	dailyDeliveryTimeInput: string | null;
	/** Current daily delivery time in minutes since midnight, or null. */
	dailyDeliveryTimeMinutes: number | null;
	/** Whether the user uses 24-hour time format. */
	is24: boolean;
	/** Human-readable label for market-open time (e.g. "9:30 AM"), or null if unavailable. */
	marketOpenLabel: string | null;
	/** Whether the current delivery time already matches market-open. */
	isMarketOpenTime: boolean;
}

const props = defineProps<Props>();

const emit = defineEmits<{
	(event: "update:emailEnabled", value: boolean): void;
	(event: "update:smsEnabled", value: boolean): void;
	(event: "dailyTimeChange", value: string): void;
	(event: "clearDeliveryTime"): void;
	(event: "setMarketOpen"): void;
}>();

const emailEnabled = computed({
	get: () => props.emailEnabled,
	set: (value: boolean) => emit("update:emailEnabled", value),
});
const smsEnabled = computed({
	get: () => props.smsEnabled,
	set: (value: boolean) => emit("update:smsEnabled", value),
});

const hasNotificationChannel = computed(
	() =>
		props.emailEnabled ||
		(props.smsEnabled && props.phoneVerified && !props.smsOptedOut),
);

const canSetMarketOpen = computed(
	() => hasNotificationChannel.value && !props.isMarketOpenTime,
);
</script>
