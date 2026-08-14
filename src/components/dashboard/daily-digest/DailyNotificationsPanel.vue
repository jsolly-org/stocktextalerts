<template>
	<form
		ref="extrasFormElement"
		:id="DASHBOARD_DAILY_NOTIFICATIONS_FORM_ID"
		method="POST"
		action="/api/notification-preferences/update"
		aria-label="Daily Digest"
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
			/>

			<div class="card-body">
			<header class="section-header">
				<h2
					:id="DASHBOARD_SECTION_IDS.dailyNotifications"
					class="section-title"
				>
					Daily Digest
				</h2>
				<p class="section-desc">
					Everything enabled below is bundled into <strong class="font-semibold text-label">one daily message</strong> sent 30 minutes before US regular trading hours (9:00 AM ET) on session days. Weekends and full-day holidays are skipped.
				</p>
				<div v-if="isHydrated && nextDailyDeliveryText" class="mt-3">
					<p class="inline-flex items-center gap-2 text-sm text-body-secondary">
						<BellAlertIcon class="size-4 shrink-0 text-success-strong" aria-hidden="true" />
						<span>Next delivery <span class="font-medium text-heading">{{ nextDailyDeliveryText }}</span>. It can take a minute or two for the notification to arrive.</span>
					</p>
				</div>
			</header>

		<SetupRequiredNotice
			:needs-tracked-assets="needsTrackedAssets"
			:needs-channel-selection="needsChannelSelection"
		/>

	<fieldset
			class="transition-opacity duration-200"
				:class="{ 'opacity-50': notificationSetupBlocked }"
			>
					<legend class="sr-only">Daily digest settings</legend>

				<div class="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 divide-y divide-divider">
				<div class="col-span-2 grid grid-cols-subgrid items-center gap-x-3 py-3">
					<span class="select-all-text inline-flex h-4 items-center text-xs font-semibold uppercase tracking-wider text-faint select-none">Select all</span>
					<label class="inline-flex items-center justify-self-end gap-1.5 leading-none">
						<input
							ref="selectAllRef"
							type="checkbox"
							:checked="allChecked"
							class="select-all-checkbox"
							aria-label="Select all daily digest options"
							@change="toggleAll"
						/>
						<span class="select-all-text text-xs font-semibold text-body-secondary leading-none">All</span>
					</label>
				</div>

				<div
					v-for="option in digestOptions"
					:key="option.field"
					class="col-span-2 grid grid-cols-subgrid items-center gap-x-3 py-3"
				>
					<div class="min-w-0">
						<input
							type="hidden"
							:name="option.field"
							:value="option.model.value ? 'on' : 'off'"
						/>
						<div class="flex items-center gap-2">
							<span
								:id="`${option.field}_label`"
								class="option-title"
							>
								{{ option.label }}
							</span>
							<MassiveLogoIcon
								v-if="option.logo === 'massive'"
								class="h-4.5 w-auto shrink-0"
								aria-label="Powered by Massive"
								role="img"
							/>
							<template v-if="option.logo === 'grok'">
								<GrokLogoLightIcon class="h-4.5 w-auto shrink-0 dark:hidden" aria-label="Powered by Grok" role="img" />
								<GrokLogoDarkIcon class="hidden h-4.5 w-auto shrink-0 dark:block" aria-label="Powered by Grok" role="img" />
							</template>
							<template v-if="option.logo === 'pm'">
								<PolymarketLogoIcon class="h-4.5 w-auto shrink-0" aria-label="Polymarket" role="img" />
								<KalshiLogoIcon class="h-4.5 w-auto shrink-0" aria-label="Kalshi" role="img" />
							</template>
						</div>
						<p
							:id="`${option.field}_description`"
							class="option-desc"
						>
							{{ option.description }}
						</p>
					</div>
					<div class="shrink-0 justify-self-end">
						<ToggleSwitch
							v-model="option.model.value"
							:sr-label="`Toggle ${option.label}`"
							:aria-labelledby="`${option.field}_label`"
							:aria-describedby="`${option.field}_description`"
						/>
					</div>
				</div>

				<DailyAssetEventsFieldset
					class="col-span-2 grid grid-cols-subgrid"
					:has-tracked-assets="hasTrackedAssets"
					:models="assetEventModels"
					@update:models="onAssetEventModelsUpdate"
				/>
				</div>

				</fieldset>
			</div>
		</section>
	</form>
</template>

<script lang="ts" setup>
import { DateTime } from "luxon";
import { computed, onMounted, onUnmounted, reactive, ref, toRefs, watch, watchEffect } from "vue";
import BellAlertIcon from "../../../icons/bell-alert.svg?component";
import GrokLogoDarkIcon from "../../../icons/grok-dark.svg?component";
import GrokLogoLightIcon from "../../../icons/grok-light.svg?component";
import KalshiLogoIcon from "../../../icons/kalshi.svg?component";
import MassiveLogoIcon from "../../../icons/massive.svg?component";
import PolymarketLogoIcon from "../../../icons/polymarket.svg?component";
import { DASHBOARD_SECTION_IDS } from "../../../lib/constants";
import { needsNotificationChannelSelection } from "../../../lib/messaging/delivery-channel";
import { getUsBeforeOpenLocalMinutes } from "../../../lib/time/conversion";
import {
	formatCountdownWithSeconds,
	getSecondsUntilNextSend,
	minutesToTimeInputValue,
} from "../../../lib/time/display";
import ToggleSwitch from "../../ToggleSwitch.vue";
import { useHydrated } from "../../useHydrated";
import { useAutoSaveForm } from "../composables/useAutoSaveNotificationPreferences";
import { useDashboardUser } from "../composables/useDashboardUser";
import { DASHBOARD_DAILY_NOTIFICATIONS_FORM_ID } from "../constants";
import FormStatusBadge from "../shared/FormStatusBadge.vue";
import SetupRequiredNotice from "../shared/SetupRequiredNotice.vue";
import type { NotificationPreferencesData } from "../types";
import {
	ASSET_EVENT_TYPES,
	type AssetEventKey,
	selectableAssetEventKeys as selectableAssetEventKeysFor,
} from "./asset-event-types";
import DailyAssetEventsFieldset from "./DailyAssetEventsFieldset.vue";

interface Props {
	hasTrackedAssets: boolean;
}

const props = defineProps<Props>();
const { hasTrackedAssets } = toRefs(props);

const user = useDashboardUser();

const needsChannelSelection = computed(() => needsNotificationChannelSelection(user.value));
const needsTrackedAssets = computed(() => !hasTrackedAssets.value);
const notificationSetupBlocked = computed(
	() => needsChannelSelection.value || needsTrackedAssets.value,
);

const isHydrated = useHydrated();
const tick = ref(0);
let intervalId: number | null = null;

onMounted(() => {
	tick.value = Date.now();
	intervalId = window.setInterval(() => {
		tick.value = Date.now();
	}, 1000);
});
onUnmounted(() => {
	if (intervalId === null) return;
	window.clearInterval(intervalId);
	intervalId = null;
});

const extrasFormElement = ref<HTMLFormElement | null>(null);
const {
	handleFormChange,
	handleFormInput,
	handleFormSubmit,
	isSaving,
	notifyChange,
	savedData,
	statusMessage,
	statusTone,
} = useAutoSaveForm<NotificationPreferencesData>({
	formRef: extrasFormElement,
});

const includePrices = ref(user.value.daily_digest_include_prices);
const includeTopMovers = ref(user.value.daily_digest_include_top_movers);
const includeNews = ref(user.value.daily_digest_include_news);
const includeRumors = ref(user.value.daily_digest_include_rumors);
const includePredictionMarkets = ref(user.value.daily_digest_include_prediction_markets);

const digestOptions = [
	{
		field: "daily_digest_include_prices",
		label: "💰 Asset Prices",
		description: "Include current prices and change percentages for your tracked assets.",
		logo: "massive" as const,
		model: includePrices,
	},
	{
		field: "daily_digest_include_top_movers",
		label: "🚀 Top Movers",
		description: "Include the day's biggest market-wide gainers and losers (US stocks priced $5+).",
		logo: "massive" as const,
		model: includeTopMovers,
	},
	{
		field: "daily_digest_include_news",
		label: "📰 News",
		description: "Include recent headlines for your tracked assets.",
		logo: "grok" as const,
		model: includeNews,
	},
	{
		field: "daily_digest_include_rumors",
		label: "💬 Rumors",
		description: "Include AI-assisted rumor and chatter summaries for your tracked assets.",
		logo: "grok" as const,
		model: includeRumors,
	},
	{
		field: "daily_digest_include_prediction_markets",
		label: "📊 Prediction Markets",
		description: "Include related Polymarket and Kalshi markets for your tracked assets.",
		logo: "pm" as const,
		model: includePredictionMarkets,
	},
];

type AssetEventUserField = `asset_events_include_${AssetEventKey}`;

function onAssetEventModelsUpdate(next: Record<AssetEventKey, boolean>) {
	Object.assign(assetEventModels, next);
}

const assetEventModels = reactive<Record<AssetEventKey, boolean>>({
	calendar: user.value.asset_events_include_calendar,
	ipo: user.value.asset_events_include_ipo,
	analyst: user.value.asset_events_include_analyst,
	insider: user.value.asset_events_include_insider,
	filings: user.value.asset_events_include_filings,
	short_interest: user.value.asset_events_include_short_interest,
});

const selectableAssetEventKeys = computed(() =>
	selectableAssetEventKeysFor(hasTrackedAssets.value),
);

const assetEventsAllChecked = computed(
	() =>
		selectableAssetEventKeys.value.length > 0 &&
		selectableAssetEventKeys.value.every((key) => assetEventModels[key]),
);
const assetEventsSomeChecked = computed(() =>
	selectableAssetEventKeys.value.some((key) => assetEventModels[key]),
);
const anyAssetEventEnabled = computed(() =>
	ASSET_EVENT_TYPES.some((t) => assetEventModels[t.key]),
);

const digestAllChecked = computed(() => digestOptions.every((o) => o.model.value));
const digestSomeChecked = computed(() => digestOptions.some((o) => o.model.value));

const allChecked = computed(() => digestAllChecked.value && assetEventsAllChecked.value);
const someChecked = computed(
	() => digestSomeChecked.value || assetEventsSomeChecked.value,
);

const selectAllRef = ref<HTMLInputElement | null>(null);

watchEffect(() => {
	if (selectAllRef.value) {
		selectAllRef.value.indeterminate = someChecked.value && !allChecked.value;
	}
});

function toggleAll() {
	const next = !allChecked.value;
	for (const option of digestOptions) {
		option.model.value = next;
	}
	if (next) {
		for (const key of selectableAssetEventKeys.value) {
			assetEventModels[key] = true;
		}
	} else {
		for (const eventType of ASSET_EVENT_TYPES) {
			assetEventModels[eventType.key] = false;
		}
	}
}

const dailyEnabled = computed(() => digestSomeChecked.value || anyAssetEventEnabled.value);

for (const eventType of ASSET_EVENT_TYPES) {
	const field = `asset_events_include_${eventType.key}` as AssetEventUserField;
	watch(
		() => user.value[field],
		(v) => {
			assetEventModels[eventType.key] = v;
		},
	);
	watch(
		() => assetEventModels[eventType.key],
		(value) => {
			if (value === user.value[field]) return;
			user.value = { ...user.value, [field]: value };
			notifyChange();
		},
	);
}

for (const option of digestOptions) {
	const field = option.field as
		| "daily_digest_include_prices"
		| "daily_digest_include_top_movers"
		| "daily_digest_include_news"
		| "daily_digest_include_rumors"
		| "daily_digest_include_prediction_markets";
	watch(
		() => user.value[field],
		(v) => {
			option.model.value = v;
		},
	);
	watch(option.model, (value) => {
		if (value === user.value[field]) return;
		user.value = { ...user.value, [field]: value };
		notifyChange();
	});
}

watch(
	() => savedData.value,
	(newData) => {
		if (!newData) return;
		includePrices.value = newData.daily_digest_include_prices;
		includeTopMovers.value = newData.daily_digest_include_top_movers;
		includeNews.value = newData.daily_digest_include_news;
		includeRumors.value = newData.daily_digest_include_rumors;
		includePredictionMarkets.value = newData.daily_digest_include_prediction_markets;
		user.value = {
			...user.value,
			daily_notification_time: newData.daily_notification_time,
			daily_notification_next_send_at: newData.daily_notification_next_send_at,
		};
	},
);

const nextDailyDeliveryText = computed(() => {
	if (!isHydrated.value || !dailyEnabled.value) return null;
	void tick.value;
	const timeInput =
		user.value.daily_notification_time !== null
			? minutesToTimeInputValue(user.value.daily_notification_time)
			: minutesToTimeInputValue(getUsBeforeOpenLocalMinutes(user.value.timezone));
	if (user.value.daily_notification_next_send_at == null && timeInput == null) return null;

	const secondsUntil = getSecondsUntilNextSend({
		nextSendAtIso: user.value.daily_notification_next_send_at,
		timeInput,
		timezone: user.value.timezone,
		now: DateTime.utc(),
	});
	if (secondsUntil === null) return null;
	return secondsUntil <= 0 ? "is due soon" : `in ${formatCountdownWithSeconds(secondsUntil)}`;
});
</script>
