<template>
	<form
		ref="assetEventsFormElement"
		:id="DASHBOARD_ASSET_EVENTS_FORM_ID"
		method="POST"
		action="/api/notification-preferences/update"
		aria-label="Asset events notifications"
		:aria-busy="isSaving"
		@input="handleFormInput"
		@change="handleFormChange"
		@submit="handleFormSubmit"
	>
		<section class="card relative">
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

			<div :class="`card-accent ${CARD_GRADIENT_ACCENTS.purple}`"></div>
		<div class="card-body">
		<fieldset :disabled="isSaving" class="min-w-0">
			<header class="mb-4">
				<h2
					:id="DASHBOARD_SECTION_IDS.assetEvents"
					class="text-xl sm:text-2xl font-bold text-heading"
				>
					Asset Events
				</h2>
				<p
					v-if="assetEventsDeliveryTimeLabel"
					class="text-sm text-body-secondary mt-1"
				>
				<span class="inline-flex items-center gap-1.5">
					<ClockIcon class="size-4 shrink-0 text-faint" aria-hidden="true" />
					<span>
						Delivered daily at
						<span class="font-medium text-label">{{ assetEventsDeliveryTimeLabel }}</span>
						<span v-if="assetEventsTimezoneLabel" class="text-muted"> ({{ assetEventsTimezoneLabel }})</span>
					<template v-if="hasDailyDeliveryTime">
						— synced with your
						<button
							type="button"
							class="font-medium text-label underline decoration-faint underline-offset-2 cursor-pointer hover:text-heading hover:decoration-body-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1 rounded transition-colors"
							@click="scrollToDailyNotifications"
						>daily delivery time</button>.
					</template>
					<template v-else>
						— set your
						<button
							type="button"
							class="font-medium text-label underline decoration-faint underline-offset-2 cursor-pointer hover:text-heading hover:decoration-body-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1 rounded transition-colors"
							@click="scrollToDailyNotifications"
						>daily delivery time</button>
						to change.
					</template>
					</span>
				</span>
			</p>
		</header>

		<SetupRequiredNotice
			:needsTrackedAssets="needsTrackedAssets"
			trackedAssetsMessage="Add at least one tracked stock to enable calendar events, analyst consensus, and insider trades"
			:needsChannelSelection="needsChannelSelection"
			:needsPhoneVerification="needsPhoneVerification"
			:phoneVerificationSectionId="phoneVerificationSectionId"
		/>

		<!-- Asset Events — each event type has its own Email/SMS toggles -->
		<div class="mt-4 space-y-3">
			<!-- Select all Email / SMS — column header -->
				<div
					class="flex items-center justify-between gap-3 px-4 transition-opacity duration-200"
					:class="{ 'opacity-50': needsChannelSelection }"
				>
				<span class="text-xs font-semibold uppercase tracking-wider text-faint select-none">Select all</span>
				<div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4 shrink-0">
					<label class="inline-flex items-center gap-1.5" :class="needsChannelSelection ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'">
						<input
							ref="selectAllEmailRef"
							type="checkbox"
							:checked="allEmailChecked"
							:disabled="needsChannelSelection"
							class="rounded border-edge-strong text-purple-600 focus:ring-purple-500 h-4 w-4"
							:class="needsChannelSelection ? 'cursor-not-allowed' : 'cursor-pointer'"
							aria-label="Select all Email"
							@change="toggleAllEmail"
						/>
						<span class="text-sm font-medium text-body-secondary">Email</span>
					</label>
					<label class="inline-flex items-center gap-1.5" :class="smsReady && !notificationSetupBlocked ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'">
						<input
							ref="selectAllSmsRef"
							type="checkbox"
							:checked="allSmsChecked"
							:disabled="needsChannelSelection || !smsReady"
							class="rounded border-edge-strong text-purple-600 focus:ring-purple-500 h-4 w-4"
							:class="smsReady && !notificationSetupBlocked ? 'cursor-pointer' : 'cursor-not-allowed'"
							aria-label="Select all SMS"
							@change="toggleAllSms"
						/>
						<span class="text-sm font-medium text-body-secondary">SMS</span>
					</label>
				</div>
			</div>

				<div
					v-for="eventType in ASSET_EVENT_TYPES"
					:key="eventType.key"
					class="rounded-xl border border-edge bg-surface p-4 transition-opacity duration-200"
					:class="{ 'opacity-50': isEventTypeBlocked(eventType.key) }"
				>
			<div class="flex items-center justify-between gap-3">
				<input
					type="hidden"
					:name="`asset_events_include_${eventType.key}_email`"
					:value="assetEventRefs[eventType.key].email.value ? 'on' : 'off'"
				/>
				<input
					type="hidden"
					:name="`asset_events_include_${eventType.key}_sms`"
					:value="assetEventRefs[eventType.key].sms.value ? 'on' : 'off'"
				/>
				<div class="min-w-0">
					<div class="flex items-center gap-2">
						<span
							:id="`asset_events_${eventType.key}_label`"
							class="text-base font-semibold text-heading"
						>
							{{ eventType.label }}
						</span>
						<MassiveLogoIcon v-if="eventType.massive" class="h-4.5 w-auto shrink-0" aria-label="Powered by Massive" role="img" />
						<FinnhubLogoIcon v-if="eventType.finnhub" class="h-4.5 w-auto shrink-0" aria-label="Powered by Finnhub" role="img" />
					</div>
					<p
						:id="`asset_events_${eventType.key}_description`"
						class="text-sm text-body-secondary mt-0.5"
					>
						<template v-if="eventType.key === 'insider' || eventType.key === 'analyst'">
							{{ eventType.description }}
							<span class="text-faint"> Stocks only.</span>
						</template>
						<template v-else>
							{{ eventType.description }}
						</template>
					</p>
				</div>
				<div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4 shrink-0">
					<label class="inline-flex items-center gap-1.5" :class="isEventTypeBlocked(eventType.key) ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'">
						<input
							type="checkbox"
							v-model="assetEventRefs[eventType.key].email.value"
							:disabled="isEventTypeBlocked(eventType.key)"
							class="rounded border-edge-strong text-purple-600 focus:ring-purple-500 h-4 w-4"
							:class="isEventTypeBlocked(eventType.key) ? 'cursor-not-allowed' : 'cursor-pointer'"
							:aria-label="`${eventType.label} Email`"
							:aria-describedby="`asset_events_${eventType.key}_description`"
						/>
						<span class="text-sm font-normal text-label">Email</span>
					</label>
					<label class="inline-flex items-center gap-1.5" :class="smsReady && !notificationSetupBlocked ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'">
						<input
							type="checkbox"
							v-model="assetEventRefs[eventType.key].sms.value"
							:disabled="isEventTypeBlocked(eventType.key) || !smsReady"
							class="rounded border-edge-strong text-purple-600 focus:ring-purple-500 h-4 w-4"
							:class="smsReady && !notificationSetupBlocked ? 'cursor-pointer' : 'cursor-not-allowed'"
							:aria-label="`${eventType.label} SMS`"
							:aria-describedby="`asset_events_${eventType.key}_description`"
						/>
						<span class="text-sm font-normal text-label">SMS</span>
					</label>
				</div>
			</div>
		</div>
		</div>

		<div v-if="isHydrated && assetEventsEnabled && nextAssetEventsDeliveryText" class="mt-4 rounded-xl border border-edge bg-surface p-4 transition-opacity duration-200" :class="{ 'opacity-50': needsChannelSelection }">
			<p class="inline-flex items-center gap-2 text-sm text-body-secondary">
				<BellAlertIcon class="size-4 shrink-0 text-success-strong" aria-hidden="true" />
				<span>Next delivery <span class="font-medium text-heading">{{ nextAssetEventsDeliveryText }}</span>.</span>
			</p>
		</div>

			</fieldset>
			</div>
		</section>
	</form>

</template>

<script lang="ts" setup>
import { DateTime } from "luxon";
import { computed, onMounted, onUnmounted, ref, toRefs, watch, watchEffect } from "vue";
// ?component suffix required: Astro Icon cannot be used in Vue; vite-svg-loader compiles this to a Vue component.
import ArrowPathIcon from "../../../icons/arrow-path.svg?component";
import BellAlertIcon from "../../../icons/bell-alert.svg?component";
import ClockIcon from "../../../icons/clock.svg?component";
import FinnhubLogoIcon from "../../../icons/finnhub.svg?component";
import MassiveLogoIcon from "../../../icons/massive.svg?component";
import { getScrollBehavior } from "../../../lib/accessibility";
import {
	CARD_GRADIENT_ACCENTS,
	DASHBOARD_ASSET_EVENTS_FORM_ID,
	DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID,
	DASHBOARD_SECTION_IDS,
	STATUS_TONE_CLASSES,
} from "../../../lib/constants";
import {
	formatCountdownWithSeconds,
	formatMinutesAsLocalTime,
} from "../../../lib/time/format";
import { calculateNextSendAt } from "../../../lib/time/scheduled-times";
import FadeTransition from "../../FadeTransition.vue";
import {
	type NotificationPreferencesData,
	useAutoSaveForm,
} from "../composables/useAutoSaveNotificationPreferences";
import { useDashboardUser } from "../composables/useDashboardUser";
import SetupRequiredNotice from "../shared/SetupRequiredNotice.vue";

interface Props {
	emailEnabled: boolean;
	phoneVerified: boolean;
	hasTrackedAssets: boolean;
}

const props = defineProps<Props>();
const {
	emailEnabled,
	phoneVerified,
	hasTrackedAssets,
} = toRefs(props);

// Inject the shared mutable user ref from DashboardPanels
const user = useDashboardUser();

const assetEventsFormElement = ref<HTMLFormElement | null>(null);
const {
	handleFormChange,
	handleFormInput,
	handleFormSubmit,
	isSaving,
	notifyChange,
	savedData: savedAssetEventsData,
	statusMessage,
	statusTone,
} = useAutoSaveForm<NotificationPreferencesData>({
	formRef: assetEventsFormElement,
});

const phoneVerificationSectionId = `${DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID}-phone-verification-section`;

const smsOptedOut = computed(() => user.value.sms_opted_out === true);
const smsNotificationsEnabled = computed(() => user.value.sms_notifications_enabled === true);
const smsReady = computed(
	() => phoneVerified.value && !smsOptedOut.value && smsNotificationsEnabled.value,
);
const hasNotificationChannel = computed(
	() =>
		emailEnabled.value ||
		(user.value.asset_events_include_calendar_sms ||
			user.value.asset_events_include_ipo_sms ||
			user.value.asset_events_include_analyst_sms ||
			user.value.asset_events_include_insider_sms) &&
			smsReady.value,
);
const needsChannelSelection = computed(() => !hasNotificationChannel.value);
const needsTrackedAssets = computed(() => !hasTrackedAssets.value);
const notificationSetupBlocked = computed(
	() => needsChannelSelection.value || needsTrackedAssets.value,
);
const needsPhoneVerification = computed(
	() =>
		(user.value.asset_events_include_calendar_sms ||
			user.value.asset_events_include_ipo_sms ||
			user.value.asset_events_include_analyst_sms ||
			user.value.asset_events_include_insider_sms) &&
		!phoneVerified.value,
);

/* =============
Asset event type definitions — drives both the template loop and the ref map.
============= */
const ASSET_EVENT_TYPES = [
	{
		key: "calendar" as const,
		label: "Calendar Events",
		description:
			"Included in your daily delivery when earnings, ex-dividend dates, or stock splits are scheduled in the next 3 days.",
		massive: true,
		finnhub: false,
	},
	{
		key: "ipo" as const,
		label: "Upcoming IPOs",
		description:
			"Included in your daily delivery when an IPO listing date is within the next 3 days.",
		massive: true,
		finnhub: false,
	},
	{
		key: "analyst" as const,
		label: "Analyst Consensus",
		description:
			"Sent at most once per month, usually in your first delivery of the month.",
		massive: false,
		finnhub: true,
	},
	{
		key: "insider" as const,
		label: "Insider Trades",
		description:
			"Can appear in your daily delivery when new insider filings are available.",
		massive: false,
		finnhub: true,
	},
] as const;

type AssetEventKey = (typeof ASSET_EVENT_TYPES)[number]["key"];

function isEventTypeBlockedByAssets(key: AssetEventKey): boolean {
	return !hasTrackedAssets.value && key !== "ipo";
}

function isEventTypeBlocked(key: AssetEventKey): boolean {
	return needsChannelSelection.value || isEventTypeBlockedByAssets(key);
}

const selectableEventTypes = computed(() =>
	ASSET_EVENT_TYPES.filter((t) => !isEventTypeBlockedByAssets(t.key)),
);

/** Per-type email/sms refs, keyed by event type. */
const assetEventRefs: Record<AssetEventKey, { email: ReturnType<typeof ref<boolean>>; sms: ReturnType<typeof ref<boolean>> }> = {
	calendar: { email: ref(user.value.asset_events_include_calendar_email), sms: ref(user.value.asset_events_include_calendar_sms) },
	ipo: { email: ref(user.value.asset_events_include_ipo_email), sms: ref(user.value.asset_events_include_ipo_sms) },
	analyst: { email: ref(user.value.asset_events_include_analyst_email), sms: ref(user.value.asset_events_include_analyst_sms) },
	insider: { email: ref(user.value.asset_events_include_insider_email), sms: ref(user.value.asset_events_include_insider_sms) },
};

const assetEventsEnabled = computed(() =>
	ASSET_EVENT_TYPES.some(
		(t) => assetEventRefs[t.key].email.value || assetEventRefs[t.key].sms.value,
	),
);

/* =============
Select-all Email / SMS
============= */
const allEmailChecked = computed(() =>
	selectableEventTypes.value.length > 0 &&
	selectableEventTypes.value.every((t) => assetEventRefs[t.key].email.value),
);
const someEmailChecked = computed(() =>
	selectableEventTypes.value.some((t) => assetEventRefs[t.key].email.value),
);

const allSmsChecked = computed(() =>
	selectableEventTypes.value.length > 0 &&
	selectableEventTypes.value.every((t) => assetEventRefs[t.key].sms.value),
);
const someSmsChecked = computed(() =>
	selectableEventTypes.value.some((t) => assetEventRefs[t.key].sms.value),
);

const selectAllEmailRef = ref<HTMLInputElement | null>(null);
const selectAllSmsRef = ref<HTMLInputElement | null>(null);

watchEffect(() => {
	if (selectAllEmailRef.value) {
		selectAllEmailRef.value.indeterminate = someEmailChecked.value && !allEmailChecked.value;
	}
});
watchEffect(() => {
	if (selectAllSmsRef.value) {
		selectAllSmsRef.value.indeterminate = someSmsChecked.value && !allSmsChecked.value;
	}
});

function toggleAllEmail() {
	const next = !allEmailChecked.value;
	for (const eventType of selectableEventTypes.value) {
		assetEventRefs[eventType.key].email.value = next;
	}
}

function toggleAllSms() {
	const next = !allSmsChecked.value;
	for (const eventType of selectableEventTypes.value) {
		assetEventRefs[eventType.key].sms.value = next;
	}
}

const DEFAULT_ASSET_EVENTS_DELIVERY_MINUTES = 540; // 9:00 AM
const assetEventsDeliveryTimeMinutes = computed(() =>
	user.value.daily_digest_time ?? DEFAULT_ASSET_EVENTS_DELIVERY_MINUTES,
);
const assetEventsDeliveryTimeLabel = computed(() =>
	formatMinutesAsLocalTime(assetEventsDeliveryTimeMinutes.value, user.value.use_24_hour_time),
);
const assetEventsTimezoneLabel = computed(() => {
	if (!user.value.timezone) return null;
	const dt = DateTime.now().setZone(user.value.timezone);
	return dt.isValid ? dt.toFormat("ZZZZ") : null;
});
const hasDailyDeliveryTime = computed(() => user.value.daily_digest_time != null);

const tick = ref(0);
let tickIntervalId: number | null = null;
const nextAssetEventsDeliveryText = computed(() => {
	if (!isHydrated.value || !assetEventsEnabled.value) return null;
	void tick.value; // Subscribe to tick updates for countdown reactivity

	const now = DateTime.utc();
	const nextSendAt = user.value.asset_events_next_send_at;
	if (nextSendAt) {
		const next = DateTime.fromISO(nextSendAt, { zone: "utc" });
		if (next.isValid) {
			const diffSeconds = next.diff(now, "seconds").seconds;
			if (diffSeconds > 0) {
				// Round up so small positive deltas don't display as "in 0s"
				return `in ${formatCountdownWithSeconds(Math.ceil(diffSeconds))}`;
			}
		}
	}
	const tz = user.value.timezone;
	if (!tz) return null;
	const nextDelivery = calculateNextSendAt(assetEventsDeliveryTimeMinutes.value, tz, now);
	if (!nextDelivery) return null;
	const fallbackSeconds = Math.ceil(nextDelivery.diff(now, "seconds").seconds);
	if (fallbackSeconds <= 0) return null;
	return `in ${formatCountdownWithSeconds(fallbackSeconds)}`;
});

function scrollToDailyNotifications() {
	const el = document.getElementById(DASHBOARD_SECTION_IDS.dailyNotifications);
	if (el) el.scrollIntoView({ behavior: getScrollBehavior() });
}

const isHydrated = ref(false);

onMounted(() => {
	isHydrated.value = true;
	tick.value = Date.now();
	tickIntervalId = window.setInterval(() => {
		tick.value = Date.now();
	}, 1000);
});
onUnmounted(() => {
	if (tickIntervalId !== null) {
		window.clearInterval(tickIntervalId);
		tickIntervalId = null;
	}
});

/* =============
Asset-event watchers: sync user → local refs and local refs → user + autosave.
One pair of watchers per event type keeps things DRY via the ASSET_EVENT_TYPES array.
============= */
type AssetEventUserFieldEmail = `asset_events_include_${AssetEventKey}_email`;
type AssetEventUserFieldSms = `asset_events_include_${AssetEventKey}_sms`;

for (const eventType of ASSET_EVENT_TYPES) {
	const emailField = `asset_events_include_${eventType.key}_email` as AssetEventUserFieldEmail;
	const smsField = `asset_events_include_${eventType.key}_sms` as AssetEventUserFieldSms;
	const refs = assetEventRefs[eventType.key];

	// user → local refs (server response pushed to shared user ref)
	watch(() => user.value[emailField], (v) => { refs.email.value = v; });
	watch(() => user.value[smsField], (v) => { refs.sms.value = v; });

	// local refs → user + autosave
	watch([refs.email, refs.sms], ([email, sms]) => {
		if (email === user.value[emailField] && sms === user.value[smsField]) return;
		user.value = { ...user.value, [emailField]: email, [smsField]: sms };
		notifyChange();
	});
}

// Update shared user ref directly when auto-save response arrives
watch(
	() => savedAssetEventsData.value,
	(newData) => {
		if (newData) {
		user.value = {
			...user.value,
			// Keep other panels' scheduling in sync with the server response.
			daily_digest_next_send_at: newData.daily_digest_next_send_at,
			asset_events_next_send_at: newData.asset_events_next_send_at,
			market_scheduled_asset_price_next_send_at: newData.market_scheduled_asset_price_next_send_at,
			// Sync per-type asset events state from server response
			...(newData.asset_events_include_calendar_email !== undefined && {
				asset_events_include_calendar_email: newData.asset_events_include_calendar_email,
			}),
			...(newData.asset_events_include_calendar_sms !== undefined && {
				asset_events_include_calendar_sms: newData.asset_events_include_calendar_sms,
			}),
			...(newData.asset_events_include_ipo_email !== undefined && {
				asset_events_include_ipo_email: newData.asset_events_include_ipo_email,
			}),
			...(newData.asset_events_include_ipo_sms !== undefined && {
				asset_events_include_ipo_sms: newData.asset_events_include_ipo_sms,
			}),
			...(newData.asset_events_include_analyst_email !== undefined && {
				asset_events_include_analyst_email: newData.asset_events_include_analyst_email,
			}),
			...(newData.asset_events_include_analyst_sms !== undefined && {
				asset_events_include_analyst_sms: newData.asset_events_include_analyst_sms,
			}),
			...(newData.asset_events_include_insider_email !== undefined && {
				asset_events_include_insider_email: newData.asset_events_include_insider_email,
			}),
			...(newData.asset_events_include_insider_sms !== undefined && {
				asset_events_include_insider_sms: newData.asset_events_include_insider_sms,
			}),
		};
		}
	},
);
</script>
