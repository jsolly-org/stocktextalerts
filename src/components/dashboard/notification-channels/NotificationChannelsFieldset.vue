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
						Global email toggle. Individual notification types are configured in each section.
					</span>
				</div>
				<ToggleSwitch
					v-model="emailEnabledModel"
					sr-label="Email notifications"
					:aria-labelledby="`${props.emailNotificationsEnabledId}_label`"
					:aria-describedby="`${props.emailNotificationsEnabledId}_desc`"
				/>
			</div>

			<div>
				<div v-if="props.phoneVerified" class="flex items-center justify-between gap-3 py-4">
					<input
						type="hidden"
						name="sms_notifications_enabled"
						:value="smsEnabledModel ? 'on' : 'off'"
					/>
					<div>
						<span :id="`${props.smsStatusId}_label`" class="text-sm font-medium text-heading">SMS Notifications</span>
						<span :id="`${props.smsStatusId}_desc`" class="block text-sm text-muted">
							Global SMS toggle. Individual notification types are configured in each section.
						</span>
					</div>
					<ToggleSwitch
						v-model="smsEnabledModel"
						sr-label="SMS notifications"
						:disabled="props.smsOptedOut"
						:aria-labelledby="`${props.smsStatusId}_label`"
						:aria-describedby="`${props.smsStatusId}_desc`"
					/>
				</div>

				<StatusMessage v-if="props.smsOptedOut" tone="warning" class="mb-4">
					SMS notifications are paused. Reply <strong>START</strong> to <a v-if="props.smsPhoneNumber" :href="`sms:${props.smsPhoneNumber}`" class="link-action font-medium">{{ props.smsPhoneNumber }}</a><span v-else>the number you receive alerts from</span> to resume.
				</StatusMessage>

				<SmsVerificationSection
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
						:clearable="props.dailyDeliveryTimeMinutes !== null"
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
	smsNotificationsEnabled: boolean;
	phoneVerified: boolean;
	smsOptedOut: boolean;
	smsPhoneNumber: string;
	emailNotificationsEnabledId: string;
	smsStatusId: string;
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
	(event: "update:smsNotificationsEnabled", value: boolean): void;
	(event: "dailyTimeChange", value: string): void;
	(event: "clearDeliveryTime"): void;
	(event: "setMarketOpen"): void;
}>();

const emailEnabledModel = computed({
	get: () => props.emailEnabled,
	set: (value: boolean) => emit("update:emailEnabled", value),
});

const smsEnabledModel = computed({
	get: () => props.smsNotificationsEnabled,
	set: (value: boolean) => emit("update:smsNotificationsEnabled", value),
});

const canSetMarketOpen = computed(
	() => !props.isMarketOpenTime,
);
</script>
