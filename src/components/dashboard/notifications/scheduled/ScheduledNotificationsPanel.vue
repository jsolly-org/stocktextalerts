<template>
	<section class="card mb-6">
		<div :class="`h-1 ${CARD_GRADIENT_ACCENTS.success}`"></div>
		<div class="card-body">
			<header class="flex items-start justify-between gap-4">
				<div>
					<h2
						:id="DASHBOARD_SECTION_IDS.scheduled"
						class="text-2xl font-bold text-gray-900"
					>
						Scheduled Notifications
					</h2>
					<p class="text-sm text-gray-600 mt-1">
						Current time: {{ currentTimeInTimezone ?? "—" }}.
						<a
							href="/profile"
							class="link-primary"
						>
							Change timezone
						</a>
					</p>
				</div>
			</header>

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
				:dailyDigestTimes="dailyDigestTimes"
				:needsChannelSelection="needsChannelSelection"
				:timePickerDisabled="timePickerDisabled"
				:canAddTime="canAddTime"
				:sendNowDisabled="sendNowDisabled"
				:isSending="isSending"
				:countdownText="countdownText"
				@send-now="handleSendNow"
				@time-change="handleTimeChange"
				@add-time="handleAddTime"
				@remove-time="handleRemoveTime"
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
	</section>

</template>

<script lang="ts" setup>
import { computed, ref, toRefs, watch } from "vue";
import {
	CARD_GRADIENT_ACCENTS,
	DASHBOARD_FORM_ID,
	DASHBOARD_SECTION_IDS,
} from "../../../../lib/constants";
import type { User } from "../../../../lib/db";
import { rootLogger } from "../../../../lib/logging";
import {
	minutesToTimeInputValue,
	parseTimeToMinutes,
} from "../../../../lib/time/format";
import StatusMessage from "../../../StatusMessage.vue";
import DailyDigestControls from "./DailyDigestControls.vue";
import SetupRequiredNotice from "./SetupRequiredNotice.vue";
import {
	useFlashMessages,
	useScheduledDigestTiming,
} from "./scheduled-notifications-helpers";

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

const MAX_DAILY_DIGEST_MINUTES = 23 * 60 + 45;
const DIGEST_INCREMENT_MINUTES = 15;
const ADD_DIGEST_OFFSET_MINUTES = 180;

function normalizeDigestTimes(times: number[]): number[] {
	const filtered = times.filter(
		(value) =>
			Number.isFinite(value) &&
			value >= 0 &&
			value <= MAX_DAILY_DIGEST_MINUTES &&
			value % DIGEST_INCREMENT_MINUTES === 0,
	);
	return [...new Set(filtered)].sort((a, b) => a - b);
}

const dailyDigestTimesMinutes = ref<number[]>(
	normalizeDigestTimes(user.value.daily_digest_notification_times ?? []),
);
const isSending = ref(false);

if (dailyDigestEnabled.value && dailyDigestTimesMinutes.value.length === 0) {
	dailyDigestTimesMinutes.value = [540];
}

const phoneVerificationSectionId = `${DASHBOARD_FORM_ID}-phone-verification-section`;

const dailyDigestTimes = computed(() =>
	dailyDigestTimesMinutes.value.map((value) => minutesToTimeInputValue(value)),
);

const timezone = computed(() => props.user.timezone ?? "");

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
const canAddTime = computed(() => {
	if (timePickerDisabled.value) {
		return false;
	}
	const times = normalizeDigestTimes(dailyDigestTimesMinutes.value);
	if (times.length === 0) {
		return true;
	}
	const nextMinutes = times[times.length - 1] + ADD_DIGEST_OFFSET_MINUTES;
	return nextMinutes <= MAX_DAILY_DIGEST_MINUTES;
});

watch(
	() => user.value.daily_digest_enabled,
	(value) => {
		dailyDigestEnabled.value = value;
	},
);
watch(
	() => user.value.daily_digest_notification_times,
	(value) => {
		dailyDigestTimesMinutes.value = normalizeDigestTimes(value ?? []);
	},
);
// Only auto-enable daily digest when user gains their first channel (transition
// from no channel to has channel). Do not run on mount: that would overwrite
// a saved preference of daily_digest_enabled = false when they already have a channel.
watch(
	hasNotificationChannel,
	(hasChannel, previousHasChannel) => {
		if (previousHasChannel === false && hasChannel && !dailyDigestEnabled.value) {
			dailyDigestEnabled.value = true;
		}
	},
);

const nextSendAt = computed(
	() =>
		props.savedPreferences?.next_send_at ?? props.user.next_send_at ?? null,
);
const { allFlashMessages, showFlashMessage } = useFlashMessages({
	flashMessages: flashMessages,
});
const { currentTimeInTimezone, countdownText } = useScheduledDigestTiming({
	timezone,
	dailyDigestEnabled,
	nextSendAtIso: nextSendAt,
	timeInputs: dailyDigestTimes,
});

async function sendDailyDigestNow() {
	if (sendNowDisabled.value) {
		return;
	}

	isSending.value = true;

	try {
		const response = await fetch("/api/notifications/daily-digest-now", {
			method: "POST",
			credentials: "same-origin",
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(10_000),
		});

		const payload = (await response.json()) as {
			ok: boolean;
			message?: string;
			tone?: "success" | "error" | "warning";
		};

		if (payload?.message) {
			const tone = payload.tone ?? (payload.ok ? "success" : "error");
			showFlashMessage(tone, payload.message);
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

async function handleSendNow() {
	if (sendNowDisabled.value) {
		return;
	}

	await sendDailyDigestNow();
}

watch(dailyDigestEnabled, () => {
	if (dailyDigestEnabled.value && dailyDigestTimesMinutes.value.length === 0) {
		dailyDigestTimesMinutes.value = [540];
	}
	onFormChanged.value();
});

function handleTimeChange(index: number, value: string) {
	const parsedMinutes = parseTimeToMinutes(value);
	if (parsedMinutes === null) {
		return;
	}
	const updated = [...dailyDigestTimesMinutes.value];
	updated[index] = parsedMinutes;
	dailyDigestTimesMinutes.value = normalizeDigestTimes(updated);
	onFormChanged.value();
}

function handleAddTime() {
	if (!canAddTime.value) {
		return;
	}
	const times = normalizeDigestTimes(dailyDigestTimesMinutes.value);
	const baseTimes = times.length === 0 ? [540] : times;
	const nextMinutes =
		baseTimes[baseTimes.length - 1] + ADD_DIGEST_OFFSET_MINUTES;
	if (nextMinutes > MAX_DAILY_DIGEST_MINUTES) {
		return;
	}
	dailyDigestTimesMinutes.value = normalizeDigestTimes([
		...baseTimes,
		nextMinutes,
	]);
	onFormChanged.value();
}

function handleRemoveTime(index: number) {
	if (dailyDigestTimesMinutes.value.length <= 1) {
		return;
	}
	const updated = [...dailyDigestTimesMinutes.value];
	updated.splice(index, 1);
	dailyDigestTimesMinutes.value = normalizeDigestTimes(updated);
	onFormChanged.value();
}
</script>
