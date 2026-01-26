<template>
	<div class="mb-6 bg-white rounded-lg shadow-md border border-gray-200 overflow-hidden">
		<div :class="`h-1 ${CARD_GRADIENT_ACCENTS.success}`"></div>
		<div class="p-6">
		<div class="flex items-start justify-between gap-4">
			<div>
				<h2
					:id="DASHBOARD_SECTION_IDS.scheduled"
					class="text-2xl font-bold text-gray-900"
				>
					Scheduled Notifications
				</h2>
				<p class="text-sm text-gray-600 mt-1">
					Configure when scheduled notifications are delivered.
				</p>
			</div>
		</div>

		<div v-if="allFlashMessages.length" class="space-y-2 mt-4">
			<StatusMessage
				v-for="(flash, index) in allFlashMessages"
				:key="index"
				:tone="flash.tone"
			>
				{{ flash.message }}
			</StatusMessage>
		</div>

		<DailyDigestControls
			v-model:enabled="dailyDigestEnabled"
			:dailyDigestTime="dailyDigestTime"
			:needsChannelSelection="needsChannelSelection"
			:timePickerDisabled="timePickerDisabled"
			:sendNowDisabled="sendNowDisabled"
			:isSending="isSending"
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
	</div>

	<SendEarlyModal
		:is-open="sendNowModalOpen"
		:is-sending="isSending"
		@close="closeSendNowModal"
		@send-and-skip-next="sendNowAndSkipNext"
		@send-without-skipping="sendNowWithoutSkipping"
	/>
</template>

<script lang="ts" setup>
import { computed, ref, toRefs, watch } from "vue";
import {
	buildDashboardRedirect,
	CARD_GRADIENT_ACCENTS,
	DASHBOARD_FORM_ID,
	DASHBOARD_SECTION_IDS,formatMessage 
} from "../../../../lib/constants";
import type { User } from "../../../../lib/db";
import { rootLogger } from "../../../../lib/logging";
import { minutesToTimeInputValue } from "../../../../lib/time/format";
import StatusMessage from "../../../StatusMessage.vue";
import DailyDigestControls from "./DailyDigestControls.vue";
import SendEarlyModal from "./SendEarlyModal.vue";
import SetupRequiredNotice from "./SetupRequiredNotice.vue";

interface Props {
	user: User;
	emailEnabled: boolean;
	smsEnabled: boolean;
	smsOptedOut: boolean;
	phoneVerified: boolean;
	onFormChanged: () => void;
	flashMessages?: { tone: "success" | "error" | "warning"; message: string }[];
	savedPreferences?: {
		next_send_at: string | null;
	} | null;
}

const props = withDefaults(defineProps<Props>(), {
	flashMessages: () => [],
});
const {
	user,
	emailEnabled,
	smsEnabled,
	smsOptedOut,
	phoneVerified,
	onFormChanged,
	flashMessages,
} = toRefs(props);

const dailyDigestEnabled = ref(user.value.daily_digest_enabled);
const dailyDigestTimeMinutes = ref(user.value.daily_digest_notification_time);
const isSending = ref(false);
const sendNowModalOpen = ref(false);
const localFlashMessages = ref<
	{ tone: "success" | "error" | "warning"; message: string }[]
>([]);

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
	() =>
		isSending.value || needsChannelSelection.value || !dailyDigestEnabled.value,
);

const allFlashMessages = computed(() => [
	...flashMessages.value,
	...localFlashMessages.value,
]);

const scheduledRedirect = (params: {
	success?: string;
	error?: string;
	warning?: string;
}) => buildDashboardRedirect({ ...params, section: "scheduled" });

function notifyFormChanged() {
	const handler = onFormChanged.value;
	handler();
}

function closeSendNowModal() {
	sendNowModalOpen.value = false;
}

function isNextSendDueSoon(): boolean {
	const nextSendAt = props.savedPreferences?.next_send_at ?? user.value.next_send_at;
	if (typeof nextSendAt !== "string") {
		return false;
	}

	const dueAtMs = Date.parse(nextSendAt);
	if (Number.isNaN(dueAtMs)) {
		return false;
	}

	const nowMs = Date.now();
	const dueSoonMs = 24 * 60 * 60 * 1000;
	return dueAtMs <= nowMs + dueSoonMs;
}

function showFlashMessage(
	tone: "success" | "error" | "warning",
	messageKey: string,
) {
	const message = formatMessage(messageKey);
	if (!message) {
		return;
	}

	const existingIndex = localFlashMessages.value.findIndex(
		(f) => f.tone === tone,
	);
	const newMessage = { tone, message };

	if (existingIndex >= 0) {
		localFlashMessages.value[existingIndex] = newMessage;
	} else {
		localFlashMessages.value.push(newMessage);
	}

	const url = new URL(window.location.href);
	url.searchParams.set(tone, messageKey);
	url.hash = "#scheduled";
	window.history.pushState(window.history.state, document.title, url.toString());

	setTimeout(() => {
		const index = localFlashMessages.value.findIndex((f) => f.tone === tone);
		if (index >= 0) {
			localFlashMessages.value.splice(index, 1);
		}
	}, 5000);
}

async function sendDailyDigestNow(params: { skipNext: boolean }) {
	if (sendNowDisabled.value) {
		return;
	}

	isSending.value = true;
	closeSendNowModal();

	try {
		const url = params.skipNext
			? "/api/notifications/daily-digest-now?skip_next=1"
			: "/api/notifications/daily-digest-now";

		const response = await fetch(url, {
			method: "POST",
			credentials: "same-origin",
			signal: AbortSignal.timeout(10_000),
			redirect: "manual",
		});

		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("Location");
			if (location) {
				const redirectUrl = new URL(location, window.location.origin);
				const successKey = redirectUrl.searchParams.get("success");
				const errorKey = redirectUrl.searchParams.get("error");
				const warningKey = redirectUrl.searchParams.get("warning");

				if (successKey) {
					showFlashMessage("success", successKey);
				}
				if (warningKey) {
					showFlashMessage("warning", warningKey);
				}
				if (errorKey) {
					showFlashMessage("error", errorKey);
				}
				return;
			}
		}

		if (response.ok) {
			showFlashMessage("success", "daily_digest_sent");
			return;
		}

		showFlashMessage("error", "daily_digest_send_failed");
	} catch (error) {
		if (error instanceof Error && error.name === "TimeoutError") {
			rootLogger.error(
				"Daily digest send request timed out",
				{ action: "send_daily_digest_now", reason: "timeout" },
				error,
			);
			showFlashMessage("error", "daily_digest_timed_out");
		} else {
			rootLogger.error(
				"Failed to send daily digest now",
				{ action: "send_daily_digest_now" },
				error,
			);
			showFlashMessage("error", "daily_digest_send_failed");
		}
	} finally {
		isSending.value = false;
	}
}

async function sendNowAndSkipNext() {
	await sendDailyDigestNow({ skipNext: true });
}

async function sendNowWithoutSkipping() {
	await sendDailyDigestNow({ skipNext: false });
}

async function handleSendNow() {
	if (sendNowDisabled.value) {
		return;
	}

	if (isNextSendDueSoon()) {
		sendNowModalOpen.value = true;
		return;
	}

	await sendDailyDigestNow({ skipNext: false });
}

watch(dailyDigestEnabled, () => {
	notifyFormChanged();
});

function handleTimeChange() {
	notifyFormChanged();
}
</script>
