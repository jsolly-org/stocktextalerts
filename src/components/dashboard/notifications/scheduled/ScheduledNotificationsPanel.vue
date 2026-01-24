<template>
	<div
		ref="panelRef"
		class="mb-6 bg-white rounded-lg shadow-sm border border-gray-200 p-6"
	>
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
import { computed, onMounted, ref, toRefs, watch } from "vue";

import type { User } from "../../../../lib/db";
import { findFormElement } from "../../../../lib/forms/dom/form-discovery";
import { rootLogger } from "../../../../lib/logging";
import { minutesToTimeInputValue } from "../../../../lib/time/format";
import DailyDigestControls from "./DailyDigestControls.vue";
import SetupRequiredNotice from "./SetupRequiredNotice.vue";

interface Props {
	user: User;
	formId: string;
	emailEnabled: boolean;
	smsEnabled: boolean;
	smsOptedOut: boolean;
	phoneVerified: boolean;
}

const props = defineProps<Props>();
const { user, formId, emailEnabled, smsEnabled, smsOptedOut, phoneVerified } =
	toRefs(props);

const panelRef = ref<HTMLElement | null>(null);
const formElement = ref<HTMLFormElement | null>(null);

const dailyDigestEnabled = ref(user.value.daily_digest_enabled);
const dailyDigestTimeMinutes = ref(user.value.daily_digest_notification_time);
const isSending = ref(false);

const phoneVerificationSectionId = computed(
	() => `${formId.value}-phone-verification-section`,
);

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

function emitFormInput() {
	formElement.value?.dispatchEvent(new Event("input", { bubbles: true }));
}

async function handleSendNow() {
	if (sendNowDisabled.value) {
		return;
	}
	isSending.value = true;

	try {
		const response = await fetch("/api/notifications/daily-digest-now", {
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
	emitFormInput();
});

onMounted(() => {
	formElement.value = findFormElement({
		formId: formId.value,
		fallbackElement: panelRef.value,
	});
});
</script>
