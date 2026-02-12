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
				class="text-xl sm:text-2xl font-bold text-gray-900 transition-opacity duration-200"
				:class="{ 'opacity-50': needsChannelSelection }"
			>
				Asset Events
			</h2>
			<p
				v-if="assetEventsDeliveryTimeLabel"
				class="text-sm text-gray-600 mt-1 transition-opacity duration-200"
				:class="{ 'opacity-50': needsChannelSelection }"
			>
				<span class="inline-flex items-center gap-1.5">
					<ClockIcon class="size-4 shrink-0 text-gray-400" aria-hidden="true" />
					<span>
						Delivered daily at
						<span class="font-medium text-gray-700">{{ assetEventsDeliveryTimeLabel }}</span>
						<span v-if="assetEventsTimezoneLabel" class="text-gray-500"> ({{ assetEventsTimezoneLabel }})</span>
					<template v-if="hasDailyDeliveryTime">
						— synced with your
						<button
							type="button"
							class="font-medium text-gray-700 underline decoration-gray-400 underline-offset-2 cursor-pointer hover:text-gray-900 hover:decoration-gray-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1 rounded transition-colors"
							@click="scrollToDailyNotifications"
						>daily delivery time</button>.
					</template>
					<template v-else>
						— set your
						<button
							type="button"
							class="font-medium text-gray-700 underline decoration-gray-400 underline-offset-2 cursor-pointer hover:text-gray-900 hover:decoration-gray-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1 rounded transition-colors"
							@click="scrollToDailyNotifications"
						>daily delivery time</button>
						to change.
					</template>
					</span>
				</span>
			</p>
		</header>

			<SetupRequiredNotice
				:needsChannelSelection="needsChannelSelection"
				:needsPhoneVerification="needsPhoneVerification"
				:phoneVerificationSectionId="phoneVerificationSectionId"
			/>

		<!-- Asset Events — each event type has its own Email/SMS toggles -->
		<div
			v-for="(eventType, idx) in ASSET_EVENT_TYPES"
			:key="eventType.key"
			class="rounded-xl border border-gray-200 bg-white p-4 transition-opacity duration-200"
			:class="[
				{ 'opacity-50': needsChannelSelection },
				idx > 0 ? 'mt-4' : ''
			]"
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
							class="text-base font-semibold text-gray-900"
						>
							{{ eventType.label }}
						</span>
						<PolygonLogoIcon v-if="eventType.polygon" class="h-4.5 w-auto shrink-0" aria-label="Powered by Polygon.io" role="img" />
						<FinnhubLogoIcon v-if="eventType.finnhub" class="h-4.5 w-auto shrink-0" aria-label="Powered by Finnhub" role="img" />
					</div>
					<p
						:id="`asset_events_${eventType.key}_description`"
						class="text-sm text-gray-600 mt-0.5"
					>
						<template v-if="eventType.key === 'insider'">
							{{ eventType.description }}
							<span class="text-gray-400"> Stocks only.</span>
						</template>
						<template v-else>
							{{ eventType.description }}
						</template>
					</p>
				</div>
				<div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4 shrink-0">
					<label class="inline-flex items-center gap-1.5" :class="needsChannelSelection ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'">
						<input
							type="checkbox"
							v-model="assetEventRefs[eventType.key].email.value"
							:disabled="needsChannelSelection"
							class="rounded border-gray-300 text-purple-600 focus:ring-purple-500 h-4 w-4"
							:class="needsChannelSelection ? 'cursor-not-allowed' : 'cursor-pointer'"
							:aria-label="`${eventType.label} Email`"
							:aria-describedby="`asset_events_${eventType.key}_description`"
						/>
						<span class="text-sm text-gray-700">Email</span>
					</label>
					<label class="inline-flex items-center gap-1.5" :class="smsReady ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'">
						<input
							type="checkbox"
							v-model="assetEventRefs[eventType.key].sms.value"
							:disabled="needsChannelSelection || !smsReady"
							class="rounded border-gray-300 text-purple-600 focus:ring-purple-500 h-4 w-4"
							:class="smsReady ? 'cursor-pointer' : 'cursor-not-allowed'"
							:aria-label="`${eventType.label} SMS`"
							:aria-describedby="`asset_events_${eventType.key}_description`"
						/>
						<span class="text-sm text-gray-700">SMS</span>
					</label>
				</div>
			</div>
		</div>

		<div v-if="isHydrated && assetEventsEnabled && nextAssetEventsDeliveryText" class="mt-4 rounded-xl border border-gray-200 bg-white p-4 transition-opacity duration-200" :class="{ 'opacity-50': needsChannelSelection }">
			<p class="inline-flex items-center gap-2 text-sm text-gray-600">
				<BellAlertIcon class="size-4 shrink-0 text-success-strong" aria-hidden="true" />
				<span>Next delivery <span class="font-medium text-gray-900">{{ nextAssetEventsDeliveryText }}</span>.</span>
			</p>
		</div>

			</fieldset>
			</div>
		</section>
	</form>

</template>

<script lang="ts" setup>
import { DateTime } from "luxon";
import { computed, onMounted, onUnmounted, ref, toRefs, watch } from "vue";
// ?component suffix required: Astro Icon cannot be used in Vue; vite-svg-loader compiles this to a Vue component.
import ArrowPathIcon from "../../../icons/arrow-path.svg?component";
import BellAlertIcon from "../../../icons/bell-alert.svg?component";
import ClockIcon from "../../../icons/clock.svg?component";
import FinnhubLogoIcon from "../../../icons/finnhub.svg?component";
import PolygonLogoIcon from "../../../icons/polygon.svg?component";
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

/* =============
Asset event type definitions — drives both the template loop and the ref map.
============= */
const ASSET_EVENT_TYPES = [
	{
		key: "earnings" as const,
		label: "Earnings",
		description:
			"Included in your daily delivery when an earnings report is scheduled in the next 3 days.",
		polygon: true,
		finnhub: false,
	},
	{
		key: "dividends" as const,
		label: "Dividends",
		description:
			"Included in your daily delivery when an ex-dividend date is within the next 3 days.",
		polygon: true,
		finnhub: false,
	},
	{
		key: "splits" as const,
		label: "Stock Splits",
		description:
			"Included in your daily delivery when a stock split is scheduled in the next 3 days.",
		polygon: true,
		finnhub: false,
	},
	{
		key: "analyst" as const,
		label: "Analyst Consensus",
		description:
			"Sent at most once per month, usually in your first delivery of the month.",
		polygon: false,
		finnhub: true,
	},
	{
		key: "insider" as const,
		label: "Insider Trades",
		description:
			"Can appear in your daily delivery when new insider filings are available.",
		polygon: false,
		finnhub: true,
	},
] as const;

type AssetEventKey = (typeof ASSET_EVENT_TYPES)[number]["key"];

/** Per-type email/sms refs, keyed by event type. */
const assetEventRefs: Record<AssetEventKey, { email: ReturnType<typeof ref<boolean>>; sms: ReturnType<typeof ref<boolean>> }> = {
	earnings: { email: ref(user.value.asset_events_include_earnings_email), sms: ref(user.value.asset_events_include_earnings_sms) },
	dividends: { email: ref(user.value.asset_events_include_dividends_email), sms: ref(user.value.asset_events_include_dividends_sms) },
	splits: { email: ref(user.value.asset_events_include_splits_email), sms: ref(user.value.asset_events_include_splits_sms) },
	analyst: { email: ref(user.value.asset_events_include_analyst_email), sms: ref(user.value.asset_events_include_analyst_sms) },
	insider: { email: ref(user.value.asset_events_include_insider_email), sms: ref(user.value.asset_events_include_insider_sms) },
};

const assetEventsEnabled = computed(() =>
	ASSET_EVENT_TYPES.some(
		(t) => assetEventRefs[t.key].email.value || assetEventRefs[t.key].sms.value,
	),
);

const DEFAULT_ASSET_EVENTS_DELIVERY_MINUTES = 540; // 9:00 AM
const assetEventsDeliveryTimeMinutes = computed(() =>
	user.value.daily_digest_time ?? DEFAULT_ASSET_EVENTS_DELIVERY_MINUTES,
);
const assetEventsDeliveryTimeLabel = computed(() =>
	formatMinutesAsLocalTime(assetEventsDeliveryTimeMinutes.value),
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
				return `in ${formatCountdownWithSeconds(Math.round(diffSeconds))}`;
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
	if (el) el.scrollIntoView({ behavior: "smooth" });
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
			...(newData.asset_events_include_earnings_email !== undefined && {
				asset_events_include_earnings_email: newData.asset_events_include_earnings_email,
			}),
			...(newData.asset_events_include_earnings_sms !== undefined && {
				asset_events_include_earnings_sms: newData.asset_events_include_earnings_sms,
			}),
			...(newData.asset_events_include_dividends_email !== undefined && {
				asset_events_include_dividends_email: newData.asset_events_include_dividends_email,
			}),
			...(newData.asset_events_include_dividends_sms !== undefined && {
				asset_events_include_dividends_sms: newData.asset_events_include_dividends_sms,
			}),
			...(newData.asset_events_include_splits_email !== undefined && {
				asset_events_include_splits_email: newData.asset_events_include_splits_email,
			}),
			...(newData.asset_events_include_splits_sms !== undefined && {
				asset_events_include_splits_sms: newData.asset_events_include_splits_sms,
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
