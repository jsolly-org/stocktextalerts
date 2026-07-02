<template>
	<div class="mt-6 border-t border-edge pt-6">
		<h3 class="text-base font-semibold text-heading mb-1">Asset events</h3>
		<p class="text-sm text-body-secondary mb-4">
			Calendar, IPO, analyst, and insider updates bundled into the same daily message.
		</p>

		<div
			class="space-y-3 transition-opacity duration-200"
			:class="{ 'opacity-50': needsChannelSelection }"
		>
			<div class="flex items-center justify-between gap-3 px-4">
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
							aria-label="Select all Email for asset events"
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
							aria-label="Select all SMS for asset events"
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
							aria-label="Select all Telegram for asset events"
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
							<MassiveLogoIcon
								v-if="eventType.massive"
								class="h-4.5 w-auto shrink-0"
								aria-label="Powered by Massive"
								role="img"
							/>
							<FinnhubLogoIcon
								v-if="eventType.finnhub"
								class="h-4.5 w-auto shrink-0"
								aria-label="Powered by Finnhub"
								role="img"
							/>
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
							:id-prefix="`asset_events_${eventType.key}`"
							:labelledby="`asset_events_${eventType.key}_label`"
							:options="channelOptionsFor(eventType.key)"
							@toggle="(channel, selected) => handleAssetEventToggle(eventType.key, channel, selected)"
						/>
					</div>
				</div>
			</div>
		</div>
	</div>
</template>

<script lang="ts" setup>
import { computed, ref, toRefs, watch, watchEffect } from "vue";
import FinnhubLogoIcon from "../../../icons/finnhub.svg?component";
import MassiveLogoIcon from "../../../icons/massive.svg?component";
import { useDashboardUser } from "../composables/useDashboardUser";
import type { ChannelOption } from "../shared/ChannelMultiSelect.vue";
import ChannelMultiSelect from "../shared/ChannelMultiSelect.vue";
import {
	getEmailChannelDisabledTitle,
	getSmsChannelDisabledTitle,
} from "../shared/channel-disabled-titles";

interface Props {
	emailEnabled: boolean;
	phoneVerified: boolean;
	hasTrackedAssets: boolean;
	needsChannelSelection: boolean;
	notificationSetupBlocked: boolean;
	telegramPrefs?: Record<string, boolean>;
	notifyChange: () => void;
}

const props = withDefaults(defineProps<Props>(), {
	telegramPrefs: () => ({}),
});
const {
	emailEnabled,
	phoneVerified,
	hasTrackedAssets,
	needsChannelSelection,
	notificationSetupBlocked,
	notifyChange,
} = toRefs(props);

const user = useDashboardUser();

const smsOptedOut = computed(() => user.value.sms_opted_out === true);
const smsNotificationsEnabled = computed(() => user.value.sms_notifications_enabled === true);
const smsReady = computed(
	() => phoneVerified.value && !smsOptedOut.value && smsNotificationsEnabled.value,
);
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
const telegramConnected = computed(() => user.value.telegram_chat_id != null);
const telegramDisabledTitle = computed(() =>
	telegramConnected.value
		? undefined
		: "Connect Telegram in your notification channels to select this option.",
);

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

const allEmailChecked = computed(
	() =>
		selectableEventTypes.value.length > 0 &&
		selectableEventTypes.value.every((t) => assetEventRefs[t.key].email.value),
);
const someEmailChecked = computed(() =>
	selectableEventTypes.value.some((t) => assetEventRefs[t.key].email.value),
);
const allSmsChecked = computed(
	() =>
		selectableEventTypes.value.length > 0 &&
		selectableEventTypes.value.every((t) => assetEventRefs[t.key].sms.value),
);
const someSmsChecked = computed(() =>
	selectableEventTypes.value.some((t) => assetEventRefs[t.key].sms.value),
);
const allTelegramChecked = computed(
	() =>
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

type AssetEventUserFieldEmail = `asset_events_include_${AssetEventKey}_email`;
type AssetEventUserFieldSms = `asset_events_include_${AssetEventKey}_sms`;

for (const eventType of ASSET_EVENT_TYPES) {
	const emailField = `asset_events_include_${eventType.key}_email` as AssetEventUserFieldEmail;
	const smsField = `asset_events_include_${eventType.key}_sms` as AssetEventUserFieldSms;
	const refs = assetEventRefs[eventType.key];

	watch(
		() => user.value[emailField],
		(v) => {
			refs.email.value = v;
		},
	);
	watch(
		() => user.value[smsField],
		(v) => {
			refs.sms.value = v;
		},
	);

	watch([refs.email, refs.sms], ([email, sms]) => {
		if (email === user.value[emailField] && sms === user.value[smsField]) return;
		user.value = { ...user.value, [emailField]: email, [smsField]: sms };
		notifyChange.value();
	});

	watch(refs.telegram, () => {
		notifyChange.value();
	});
}

const assetEventsEnabled = computed(() =>
	ASSET_EVENT_TYPES.some(
		(t) =>
			assetEventRefs[t.key].email.value ||
			assetEventRefs[t.key].sms.value ||
			assetEventRefs[t.key].telegram.value,
	),
);

defineExpose({ assetEventsEnabled });
</script>
