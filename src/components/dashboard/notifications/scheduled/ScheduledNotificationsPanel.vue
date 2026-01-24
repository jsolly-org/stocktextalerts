<template>
	<div class="mb-6 bg-white rounded-lg shadow-sm border border-gray-200 p-6">
		<div class="flex items-start justify-between gap-4">
			<div>
				<h2 class="text-2xl font-bold text-gray-900">
					Scheduled Notifications
				</h2>
				<p class="text-sm text-gray-600 mt-1">
					Configure when scheduled notifications are delivered.
				</p>
			</div>
		</div>

		<DailyDigestControls
			v-model:enabled="dailyDigestEnabled"
			:dailyDigestTime="dailyDigestTime"
			:needsChannelSelection="needsChannelSelection"
			:timePickerDisabled="timePickerDisabled"
			:sendNowDisabled="sendNowDisabled"
			@send-now="handleSendNow"
			@time-change="handleTimeChange"
		>
			<template #setup>
				<SetupRequiredNotice
					:needsChannelSelection="needsChannelSelection"
					:needsPhoneVerification="needsPhoneVerification"
					:phoneVerificationSectionId="phoneVerificationSectionId"
				/>
			</template>
		</DailyDigestControls>
	</div>
</template>

<script lang="ts" setup>
import { computed, ref, toRefs, watch } from "vue";

import type { User } from "../../../../lib/db";
import { rootLogger } from "../../../../lib/logging";
import { minutesToTimeInputValue } from "../../../../lib/time/format";
import { DASHBOARD_FORM_ID } from "../../constants";
import DailyDigestControls from "./DailyDigestControls.vue";
import SetupRequiredNotice from "./SetupRequiredNotice.vue";

interface Props {
	user: User;
	emailEnabled: boolean;
	smsEnabled: boolean;
	smsOptedOut: boolean;
	phoneVerified: boolean;
	onFormChanged: () => void;
	savedPreferences?: {
		next_send_at: string | null;
	} | null;
}

const props = defineProps<Props>();
const {
	user,
	emailEnabled,
	smsEnabled,
	smsOptedOut,
	phoneVerified,
	onFormChanged,
} = toRefs(props);

const dailyDigestEnabled = ref(user.value.daily_digest_enabled);
const dailyDigestTimeMinutes = ref(user.value.daily_digest_notification_time);
const isSending = ref(false);

const phoneVerificationSectionId = `${DASHBOARD_FORM_ID}-phone-verification-section`;

const dailyDigestTime = computed(() =>
	minutesToTimeInputValue(dailyDigestTimeMinutes.value),
);

const smsReady = computed(
	() => smsEnabled.value && !smsOptedOut.value && phoneVerified.value,
);
const hasNotificationChannel = computed(
	() => emailEnabled.value || smsReady.value,
);
const needsChannelSelection = computed(() => !hasNotificationChannel.value);
const needsPhoneVerification = computed(
	() => smsEnabled.value && !smsOptedOut.value && !phoneVerified.value,
);
const timePickerDisabled = computed(
	() => needsChannelSelection.value || !dailyDigestEnabled.value,
);
const sendNowDisabled = computed(
	() => isSending.value || needsChannelSelection.value || !dailyDigestEnabled.value,
);

function notifyFormChanged() {
	const handler = onFormChanged.value;
	handler();
}

async function handleSendNow() {
	if (sendNowDisabled.value) {
		return;
	}
	isSending.value = true;

	try {
		let url = "/api/notifications/daily-digest-now";
		const nextSendAt =
			props.savedPreferences?.next_send_at ?? user.value.next_send_at;
		if (typeof nextSendAt === "string") {
			const dueAtMs = Date.parse(nextSendAt);
			if (!Number.isNaN(dueAtMs)) {
				const nowMs = Date.now();
				const dueSoonMs = 24 * 60 * 60 * 1000;
				if (dueAtMs <= nowMs + dueSoonMs) {
					const shouldSkipNext = window.confirm(
						"Your next daily digest is scheduled soon. Click OK to send now and skip the next scheduled digest, or Cancel to send now without skipping.",
					);
					if (shouldSkipNext) {
						url = `${url}?skip_next=1`;
					}
				}
			}
		}

		const response = await fetch(url, {
			method: "POST",
			credentials: "same-origin",
			signal: AbortSignal.timeout(10_000),
		});

		if (response.redirected) {
			window.location.assign(response.url);
			return;
		}

		if (response.ok) {
			window.location.assign("/dashboard?success=daily_digest_sent");
			return;
		}

		window.location.assign("/dashboard?error=daily_digest_send_failed");
	} catch (error) {
		if (error instanceof Error && error.name === "TimeoutError") {
			rootLogger.error(
				"Daily digest send request timed out",
				undefined,
				error,
			);
			window.location.assign("/dashboard?error=daily_digest_timed_out");
		} else {
			rootLogger.error("Failed to send daily digest now", undefined, error);
			window.location.assign("/dashboard?error=daily_digest_send_failed");
		}
	} finally {
		isSending.value = false;
	}
}

watch(dailyDigestEnabled, () => {
	notifyFormChanged();
});

function handleTimeChange() {
	notifyFormChanged();
}
</script>
