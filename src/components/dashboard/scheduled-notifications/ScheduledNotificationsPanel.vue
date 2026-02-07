<template>
	<form
		ref="scheduledFormElement"
		:id="DASHBOARD_SCHEDULED_FORM_ID"
		method="POST"
		action="/api/notification-preferences/update"
		class="space-y-6"
		aria-label="Scheduled notifications"
		:aria-busy="isSaving"
		@input="handleFormInput"
		@change="handleFormChange"
		@submit="handleFormSubmit"
	>
		<section class="card relative mb-6">
			<FadeTransition>
				<div
					v-if="statusMessage"
					class="absolute top-3 right-3 flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium z-10 border"
					:class="STATUS_TONE_CLASSES[statusTone]"
					role="status"
					aria-live="polite"
					:aria-busy="isSaving"
					:data-tone="statusTone"
				>
					<ArrowPathIcon
						v-show="isSaving"
						class="animate-spin size-3 shrink-0"
						aria-hidden="true"
					/>
					{{ statusMessage }}
				</div>
			</FadeTransition>

			<div :class="`h-1 ${CARD_GRADIENT_ACCENTS.success}`"></div>
			<div class="card-body">
				<header class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
					<div class="min-w-0">
						<h2
							:id="DASHBOARD_SECTION_IDS.scheduled"
							class="text-xl sm:text-2xl font-bold text-gray-900"
						>
							Scheduled Notifications
						</h2>
						<p class="text-sm text-gray-600 mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
							<span class="inline-flex items-center gap-1.5">
								<ClockIcon class="size-4 shrink-0 text-gray-500" aria-hidden="true" />
								<span class="text-gray-700">
									Local time:
									<span class="font-medium text-gray-900">
										{{ currentTimeInTimezone ?? "—" }}
									</span>
								</span>
							</span>
							<a
								href="/profile"
								class="inline-flex items-center gap-1 link-primary rounded-sm"
								aria-label="Change timezone in profile settings"
							>
								Change timezone
								<ArrowTopRightOnSquareIcon class="size-3.5 shrink-0" aria-hidden="true" />
							</a>
						</p>
					</div>
				</header>

				<ScheduledUpdateControls
					:enabled="scheduledUpdatesEnabled"
					:scheduledUpdateTimes="scheduledUpdateTimes"
					:needsChannelSelection="needsChannelSelection"
					:timePickerDisabled="timePickerDisabled"
					:canAddTime="canAddTime"
					:countdownText="countdownText"
					@update:enabled="handleScheduledUpdatesEnabledUpdate"
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
				</ScheduledUpdateControls>
			</div>
		</section>
	</form>

</template>

<script lang="ts" setup>
import { computed, ref, toRefs, watch } from "vue";
// ?component suffix required: Astro Icon cannot be used in Vue; vite-svg-loader compiles this to a Vue component.
import ArrowPathIcon from "../../../icons/arrow-path.svg?component";
import ArrowTopRightOnSquareIcon from "../../../icons/arrow-top-right-on-square.svg?component";
import ClockIcon from "../../../icons/clock.svg?component";
import {
	CARD_GRADIENT_ACCENTS,
	DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID,
	DASHBOARD_SCHEDULED_FORM_ID,
	DASHBOARD_SECTION_IDS,
	DEFAULT_SCHEDULED_UPDATE_TIME_MINUTES,
	STATUS_TONE_CLASSES,
} from "../../../lib/constants";
import {
	minutesToTimeInputValue,
	parseTimeToMinutes,
} from "../../../lib/time/format";
import FadeTransition from "../../FadeTransition.vue";
import {
	type NotificationPreferencesData,
	useAutoSaveForm,
} from "../composables/useAutoSaveNotificationPreferences";
import { useDashboardUser } from "../composables/useDashboardUser";
import ScheduledUpdateControls from "./ScheduledUpdateControls.vue";
import SetupRequiredNotice from "./SetupRequiredNotice.vue";
import { useScheduledUpdateTiming } from "./scheduled-notifications-helpers";

interface Props {
	emailEnabled: boolean;
	smsEnabled: boolean;
	phoneVerified: boolean;
}

const props = defineProps<Props>();
const {
	emailEnabled,
	smsEnabled,
	phoneVerified,
} = toRefs(props);

// Inject the shared mutable user ref from DashboardPanels
const user = useDashboardUser();

const scheduledFormElement = ref<HTMLFormElement | null>(null);
const {
	handleFormChange,
	handleFormInput,
	handleFormSubmit,
	isSaving,
	notifyChange,
	savedData: savedScheduledData,
	statusMessage,
	statusTone,
} = useAutoSaveForm<NotificationPreferencesData>({
	formRef: scheduledFormElement,
});

const scheduledUpdatesEnabled = ref(user.value.scheduled_updates_enabled);

const MAX_SCHEDULED_UPDATE_MINUTES = 23 * 60 + 59;
const SCHEDULED_UPDATE_INCREMENT_MINUTES = 1;
const ADD_SCHEDULED_OFFSET_MINUTES = 180;

function normalizeScheduledTimes(times: number[]): number[] {
	const filtered = times.filter(
		(value) =>
			Number.isFinite(value) &&
			value >= 0 &&
			value <= MAX_SCHEDULED_UPDATE_MINUTES &&
			value % SCHEDULED_UPDATE_INCREMENT_MINUTES === 0,
	);
	return [...new Set(filtered)].sort((a, b) => a - b);
}

const scheduledUpdateTimesMinutes = ref<number[]>(
	normalizeScheduledTimes(user.value.scheduled_update_times ?? []),
);

if (scheduledUpdatesEnabled.value && scheduledUpdateTimesMinutes.value.length === 0) {
	scheduledUpdateTimesMinutes.value = [DEFAULT_SCHEDULED_UPDATE_TIME_MINUTES];
}

const phoneVerificationSectionId = `${DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID}-phone-verification-section`;

const scheduledUpdateTimes = computed(() =>
	scheduledUpdateTimesMinutes.value.map((value) => minutesToTimeInputValue(value)),
);

const timezone = computed(() => user.value.timezone ?? "");

const smsReady = computed(
	() => smsEnabled.value && phoneVerified.value,
);
const hasNotificationChannel = computed(
	() => emailEnabled.value || smsReady.value,
);
const needsChannelSelection = computed(() => !hasNotificationChannel.value);
const needsPhoneVerification = computed(
	() => smsEnabled.value && !phoneVerified.value,
);
const timePickerDisabled = computed(
	() => needsChannelSelection.value || !scheduledUpdatesEnabled.value,
);
const canAddTime = computed(() => {
	if (timePickerDisabled.value) {
		return false;
	}
	const times = normalizeScheduledTimes(scheduledUpdateTimesMinutes.value);
	if (times.length === 0) {
		return true;
	}
	const nextMinutes = times[times.length - 1] + ADD_SCHEDULED_OFFSET_MINUTES;
	return nextMinutes <= MAX_SCHEDULED_UPDATE_MINUTES;
});

watch(
	() => user.value.scheduled_updates_enabled,
	(value) => {
		scheduledUpdatesEnabled.value = value;
	},
);
watch(
	() => user.value.scheduled_update_times,
	(value) => {
		scheduledUpdateTimesMinutes.value = normalizeScheduledTimes(value ?? []);
	},
);
// Only auto-enable scheduled updates when user gains their first channel (transition
// from no channel to has channel). Do not run on mount: that would overwrite
// a saved preference of scheduled_updates_enabled = false when they already have a channel.
watch(
	hasNotificationChannel,
	(hasChannel, previousHasChannel) => {
		if (previousHasChannel === false && hasChannel && !scheduledUpdatesEnabled.value) {
			if (scheduledUpdateTimesMinutes.value.length === 0) {
				scheduledUpdateTimesMinutes.value = [DEFAULT_SCHEDULED_UPDATE_TIME_MINUTES];
			}
			scheduledUpdatesEnabled.value = true;
			notifyChange();
		}
	},
);

const nextSendAt = computed(
	() =>
		savedScheduledData.value?.next_send_at ??
			user.value.next_send_at ??
			null,
);
const { currentTimeInTimezone, countdownText } = useScheduledUpdateTiming({
	timezone,
	scheduledUpdatesEnabled,
	nextSendAtIso: nextSendAt,
	timeInputs: scheduledUpdateTimes,
});

watch(scheduledUpdatesEnabled, () => {
	if (scheduledUpdatesEnabled.value && scheduledUpdateTimesMinutes.value.length === 0) {
		scheduledUpdateTimesMinutes.value = [DEFAULT_SCHEDULED_UPDATE_TIME_MINUTES];
	}
});

// Update shared user ref directly when auto-save response arrives
watch(
	() => savedScheduledData.value,
	(newData) => {
		if (newData) {
			user.value = {
				...user.value,
				scheduled_updates_enabled: newData.scheduled_updates_enabled,
				scheduled_update_times: newData.scheduled_update_times,
				next_send_at: newData.next_send_at,
			};
		}
	},
);

function handleScheduledUpdatesEnabledUpdate(value: boolean) {
	scheduledUpdatesEnabled.value = value;
	notifyChange();
}

function handleTimeChange(index: number, value: string) {
	const parsedMinutes = parseTimeToMinutes(value);
	if (parsedMinutes === null) {
		return;
	}
	const updated = [...scheduledUpdateTimesMinutes.value];
	updated[index] = parsedMinutes;
	scheduledUpdateTimesMinutes.value = normalizeScheduledTimes(updated);
	notifyChange();
}

function handleAddTime() {
	if (!canAddTime.value) {
		return;
	}
	const times = normalizeScheduledTimes(scheduledUpdateTimesMinutes.value);
	const baseTimes = times.length === 0 ? [DEFAULT_SCHEDULED_UPDATE_TIME_MINUTES] : times;
	const nextMinutes =
		baseTimes[baseTimes.length - 1] + ADD_SCHEDULED_OFFSET_MINUTES;
	if (nextMinutes > MAX_SCHEDULED_UPDATE_MINUTES) {
		return;
	}
	scheduledUpdateTimesMinutes.value = normalizeScheduledTimes([
		...baseTimes,
		nextMinutes,
	]);
	notifyChange();
}

function handleRemoveTime(index: number) {
	if (scheduledUpdateTimesMinutes.value.length <= 1) {
		return;
	}
	const updated = [...scheduledUpdateTimesMinutes.value];
	updated.splice(index, 1);
	scheduledUpdateTimesMinutes.value = normalizeScheduledTimes(updated);
	notifyChange();
}
</script>
