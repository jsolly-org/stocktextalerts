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
		<FormStatusBadge
			:status-message="statusMessage"
			:status-tone="statusTone"
			:is-saving="isSaving"
			show-only-for-tone="error"
		/>

			<div class="card-accent card-accent-purple"></div>
		<div class="card-body">
		<fieldset class="min-w-0">
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
			trackedAssetsMessage="Add at least one tracked asset to enable calendar events, analyst consensus, and insider trades"
			:needsChannelSelection="needsChannelSelection"
			:needsPhoneVerification="needsPhoneVerification"
			:phoneVerificationSectionId="phoneVerificationSectionId"
		/>

		<!-- Asset Events — each event type has its own channel multiselect -->
		<div class="mt-4 space-y-3">
			<!-- Select all Email / SMS / Telegram — column header -->
				<div
					class="flex items-center justify-between gap-3 px-4 transition-opacity duration-200"
					:class="{ 'opacity-50': needsChannelSelection }"
				>
				<span class="text-xs font-semibold uppercase tracking-wider text-faint select-none">Select all</span>
				<div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4 shrink-0">
					<label
						class="inline-flex items-center gap-1.5"
						:class="needsChannelSelection ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'"
						:title="emailDisabledTitle"
					>
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
					<label
						class="inline-flex items-center gap-1.5"
						:class="smsReady && !notificationSetupBlocked ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'"
						:title="smsDisabledTitle"
					>
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
					<label
						class="inline-flex items-center gap-1.5"
						:class="telegramConnected ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'"
						:title="telegramDisabledTitle"
					>
						<input
							ref="selectAllTelegramRef"
							type="checkbox"
							:checked="allTelegramChecked"
							:disabled="!telegramConnected"
							class="rounded border-edge-strong text-purple-600 focus:ring-purple-500 h-4 w-4"
							:class="telegramConnected ? 'cursor-pointer' : 'cursor-not-allowed'"
							aria-label="Select all Telegram"
							@change="toggleAllTelegram"
						/>
						<span class="text-sm font-medium text-body-secondary">Telegram</span>
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
				<input
					type="hidden"
					:name="`asset_events_include_${eventType.key}_telegram`"
					:value="assetEventRefs[eventType.key].telegram.value ? 'on' : 'off'"
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
				<div class="shrink-0">
					<ChannelMultiSelect
						:idPrefix="`asset_events_${eventType.key}`"
						:labelledby="`asset_events_${eventType.key}_label`"
						:options="channelOptionsFor(eventType.key)"
						@toggle="(channel, selected) => handleAssetEventToggle(eventType.key, channel, selected)"
					/>
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
import BellAlertIcon from "../../../icons/bell-alert.svg?component";
import ClockIcon from "../../../icons/clock.svg?component";
import FinnhubLogoIcon from "../../../icons/finnhub.svg?component";
import MassiveLogoIcon from "../../../icons/massive.svg?component";
import {
	DASHBOARD_ASSET_EVENTS_FORM_ID,
	DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID,
	DASHBOARD_SECTION_IDS,
} from "../../../lib/constants";
import {
	formatCountdownWithSeconds,
	formatMinutesAsLocalTime,
	userLocalToEtMinute,
} from "../../../lib/time/format";
import { calculateNextSendAt } from "../../../lib/time/scheduled-times";
import { useHydrated } from "../../composables/useHydrated";
import {
	type NotificationPreferencesData,
	useAutoSaveForm,
} from "../composables/useAutoSaveNotificationPreferences";
import { useDashboardUser } from "../composables/useDashboardUser";
import type { ChannelOption } from "../shared/ChannelMultiSelect.vue";
import ChannelMultiSelect from "../shared/ChannelMultiSelect.vue";
import {
	getEmailChannelDisabledTitle,
	getSmsChannelDisabledTitle,
} from "../shared/channel-disabled-titles";
import FormStatusBadge from "../shared/FormStatusBadge.vue";
import SetupRequiredNotice from "../shared/SetupRequiredNotice.vue";

interface Props {
	emailEnabled: boolean;
	phoneVerified: boolean;
	hasTrackedAssets: boolean;
	/**
	 * The user's current asset-events Telegram selections, keyed by content facet
	 * ("calendar" | "ipo" | "analyst" | "insider"). Loaded server-side from
	 * `notification_preferences` (channel='telegram'); absent facets default to off.
	 * The autosave endpoint persists Telegram to that table but does NOT echo it back
	 * in its snapshot, so these refs are the panel's own source of truth.
	 */
	telegramPrefs?: Record<string, boolean>;
}

const props = withDefaults(defineProps<Props>(), {
	telegramPrefs: () => ({}),
});
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

/**
 * Hover-text reasons for disabled channel toggles. Populated only when the
 * channel itself is unavailable — panel-level blocks (no tracked assets, no
 * channel selected at all) are surfaced via SetupRequiredNotice instead.
 */
const emailDisabledTitle = computed(() =>
	getEmailChannelDisabledTitle(emailEnabled.value),
);
const smsDisabledTitle = computed(() =>
	getSmsChannelDisabledTitle({
		smsNotificationsEnabled: smsNotificationsEnabled.value,
		phoneVerified: phoneVerified.value,
		smsOptedOut: smsOptedOut.value,
	}),
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

/** Telegram is selectable only once the account is linked (chat id present). */
const telegramConnected = computed(() => user.value.telegram_chat_id != null);
const telegramDisabledTitle = computed(() =>
	telegramConnected.value
		? undefined
		: "Connect Telegram in your notification channels to select this option.",
);

function isEventTypeBlockedByAssets(key: AssetEventKey): boolean {
	return !hasTrackedAssets.value && key !== "ipo";
}

function isEventTypeBlocked(key: AssetEventKey): boolean {
	return needsChannelSelection.value || isEventTypeBlockedByAssets(key);
}

const selectableEventTypes = computed(() =>
	ASSET_EVENT_TYPES.filter((t) => !isEventTypeBlockedByAssets(t.key)),
);

/**
 * Per-type email/sms/telegram refs, keyed by event type.
 *
 * Telegram has no `users` column — its initial state comes from the server-loaded
 * `telegramPrefs` prop (content facet ⇒ boolean; absent ⇒ off), unlike email/sms
 * which hydrate from `user.value`.
 */
const assetEventRefs: Record<
	AssetEventKey,
	{
		email: ReturnType<typeof ref<boolean>>;
		sms: ReturnType<typeof ref<boolean>>;
		telegram: ReturnType<typeof ref<boolean>>;
	}
> = {
	calendar: {
		email: ref(user.value.asset_events_include_calendar_email),
		sms: ref(user.value.asset_events_include_calendar_sms),
		telegram: ref(props.telegramPrefs.calendar === true),
	},
	ipo: {
		email: ref(user.value.asset_events_include_ipo_email),
		sms: ref(user.value.asset_events_include_ipo_sms),
		telegram: ref(props.telegramPrefs.ipo === true),
	},
	analyst: {
		email: ref(user.value.asset_events_include_analyst_email),
		sms: ref(user.value.asset_events_include_analyst_sms),
		telegram: ref(props.telegramPrefs.analyst === true),
	},
	insider: {
		email: ref(user.value.asset_events_include_insider_email),
		sms: ref(user.value.asset_events_include_insider_sms),
		telegram: ref(props.telegramPrefs.insider === true),
	},
};

const assetEventsEnabled = computed(() =>
	ASSET_EVENT_TYPES.some(
		(t) =>
			assetEventRefs[t.key].email.value ||
			assetEventRefs[t.key].sms.value ||
			assetEventRefs[t.key].telegram.value,
	),
);

/* =============
Select-all Email / SMS / Telegram
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

const allTelegramChecked = computed(() =>
	selectableEventTypes.value.length > 0 &&
	selectableEventTypes.value.every((t) => assetEventRefs[t.key].telegram.value),
);
const someTelegramChecked = computed(() =>
	selectableEventTypes.value.some((t) => assetEventRefs[t.key].telegram.value),
);

const selectAllEmailRef = ref<HTMLInputElement | null>(null);
const selectAllSmsRef = ref<HTMLInputElement | null>(null);
const selectAllTelegramRef = ref<HTMLInputElement | null>(null);

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
watchEffect(() => {
	if (selectAllTelegramRef.value) {
		selectAllTelegramRef.value.indeterminate =
			someTelegramChecked.value && !allTelegramChecked.value;
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

function toggleAllTelegram() {
	const next = !allTelegramChecked.value;
	for (const eventType of selectableEventTypes.value) {
		assetEventRefs[eventType.key].telegram.value = next;
	}
}

/* =============
Per-row channel multiselect options + toggle handler. Each event type renders one
multiselect spanning Email / SMS / Telegram. Email/SMS disabled logic mirrors the
prior per-row checkboxes verbatim; Telegram is disabled only until the account is
linked (matching the other panels).
============= */
function channelOptionsFor(key: AssetEventKey): ChannelOption[] {
	const blocked = isEventTypeBlocked(key);
	const refs = assetEventRefs[key];
	return [
		{
			value: "email",
			label: "Email",
			selected: refs.email.value === true,
			disabled: blocked,
			disabledTitle: emailDisabledTitle.value,
		},
		{
			value: "sms",
			label: "SMS",
			selected: refs.sms.value === true,
			disabled: blocked || !smsReady.value,
			disabledTitle: smsDisabledTitle.value,
		},
		{
			value: "telegram",
			label: "Telegram",
			selected: refs.telegram.value === true,
			disabled: !telegramConnected.value,
			disabledTitle: telegramDisabledTitle.value,
		},
	];
}

function handleAssetEventToggle(key: AssetEventKey, channel: string, selected: boolean) {
	const refs = assetEventRefs[key];
	if (channel === "email") refs.email.value = selected;
	else if (channel === "sms") refs.sms.value = selected;
	else if (channel === "telegram") refs.telegram.value = selected;
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
	const etMinutes = userLocalToEtMinute(assetEventsDeliveryTimeMinutes.value, tz);
	const nextDelivery = calculateNextSendAt(etMinutes, now);
	if (!nextDelivery) return null;
	const fallbackSeconds = Math.ceil(nextDelivery.diff(now, "seconds").seconds);
	if (fallbackSeconds <= 0) return null;
	return `in ${formatCountdownWithSeconds(fallbackSeconds)}`;
});

function scrollToDailyNotifications() {
	const el = document.getElementById(DASHBOARD_SECTION_IDS.dailyNotifications);
	if (el) {
		el.scrollIntoView({
			behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
				? "auto"
				: "smooth",
		});
	}
}

const isHydrated = useHydrated();

onMounted(() => {
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

	// Telegram has no `users` column, so it doesn't push into `user.value` — it
	// persists to `notification_preferences` server-side. Still trigger autosave so
	// the hidden `*_telegram` form field submits.
	watch(refs.telegram, () => {
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
