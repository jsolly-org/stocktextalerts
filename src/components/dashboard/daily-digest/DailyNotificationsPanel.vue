<template>
	<div class="space-y-6">
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

			<div :class="`card-accent ${CARD_GRADIENT_ACCENTS.teal}`"></div>
			<div class="card-body">
			<header class="mb-4">
				<h2
					:id="DASHBOARD_SECTION_IDS.dailyNotifications"
					class="text-xl sm:text-2xl font-bold text-heading"
				>
					Daily Digest
				</h2>
			<p
				class="text-sm text-body-secondary mt-1"
			>
				Everything you enable below is bundled into <strong class="font-semibold text-label">one daily message</strong> sent at the time you choose.
			</p>
			</header>

		<SetupRequiredNotice
			:needsChannelSelection="needsChannelSelection"
			:needsPhoneVerification="needsPhoneVerification"
			:phoneVerificationSectionId="phoneVerificationSectionId"
		/>

			<FadeTransition>
				<p
					v-if="dailyEnabled && dailyDeliveryTimeMinutes === null"
					class="flex items-start gap-2 rounded-lg px-3 py-2.5 text-sm bg-info-bg border border-info-border text-info-text"
					role="note"
				>
					<InformationCircleIcon class="size-5 shrink-0 mt-0.5" aria-hidden="true" />
					<span>No daily digest will be sent until you choose a notification time.</span>
				</p>
			</FadeTransition>

	<fieldset
			class="divide-y divide-divider transition-opacity duration-200"
				:class="{ 'opacity-50': needsChannelSelection }"
				:disabled="isSaving"
				:aria-disabled="needsChannelSelection ? 'true' : undefined"
			>
					<legend class="sr-only">Daily digest settings</legend>

			<div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 py-3">
				<div class="min-w-0">
					<span
						id="daily_digest_time_label"
						class="text-base font-semibold text-heading"
					>
						Delivery time
					</span>
					<p
						id="daily_digest_time_description"
						class="text-sm text-body-secondary mt-0.5"
					>
						Sent once every day.
					</p>
				</div>
				<div class="sm:shrink-0">
					<div class="flex flex-col sm:flex-row sm:items-center gap-2">
						<TimePicker
							:inputId="`daily_digest_time`"
							:inputName="`daily_digest_time`"
							:initialTime="dailyDeliveryTimeInput"
							inputAriaLabel="Daily digest delivery time"
							:disabled="needsChannelSelection"
							:clearable="dailyDeliveryTimeMinutes !== null && !needsChannelSelection"
							clearAriaLabel="Clear delivery time"
							:is24="user.use_24_hour_time"
							@time-change="handleDailyTimeChange"
							@clear="handleClearDeliveryTime"
						/>
						<button
							v-if="marketOpenLabel"
							type="button"
							class="btn btn-md btn-secondary h-[41px] shrink-0 whitespace-nowrap"
							:disabled="!canSetMarketOpen"
							:aria-label="`Set delivery time to US market open (${marketOpenLabel})`"
							@click="handleSetMarketOpen"
						>
							<PresentationChartLineIcon class="size-4 shrink-0" aria-hidden="true" />
							Market open
						</button>
					</div>
				</div>
			</div>

				<div class="flex items-center justify-between gap-3 py-3">
					<input
						type="hidden"
					name="daily_digest_include_news_email"
					:value="includeNewsEmail ? 'on' : 'off'"
				/>
				<div class="min-w-0">
					<div class="flex items-center gap-2">
						<span
							id="daily_digest_include_news_label"
								class="text-base font-semibold text-heading"
							>
								🗞️ News
							</span>
							<GrokLogoLightIcon class="h-4.5 w-auto shrink-0 dark:hidden" aria-label="Powered by Grok" role="img" />
							<GrokLogoDarkIcon class="hidden h-4.5 w-auto shrink-0 dark:inline" aria-label="Powered by Grok" role="img" />
						<FinnhubLogoIcon class="h-4.5 w-auto shrink-0" aria-label="Powered by Finnhub" role="img" />
						</div>
						<p
							id="daily_digest_include_news_description"
							class="text-sm text-body-secondary mt-0.5"
						>
							Add a short news summary about the assets you're tracking.
						</p>
					</div>
				<div class="shrink-0">
					<label class="inline-flex items-center gap-1.5" :class="emailOnlyDisabled ? 'cursor-not-allowed' : 'cursor-pointer'">
						<input
							type="checkbox"
							v-model="includeNewsEmail"
							:disabled="emailOnlyDisabled"
							class="rounded border-edge-strong text-teal-600 focus:ring-teal-500 h-4 w-4"
							:class="emailOnlyDisabled ? 'cursor-not-allowed' : 'cursor-pointer'"
							aria-describedby="daily_digest_include_news_description"
						/>
						<span class="text-sm text-label">Email</span>
					</label>
				</div>
				</div>

				<div class="flex items-center justify-between gap-3 py-3">
					<input
						type="hidden"
					name="daily_digest_include_rumors_email"
					:value="includeRumorsEmail ? 'on' : 'off'"
				/>
				<div class="min-w-0">
					<div class="flex items-center gap-2">
						<span
							id="daily_digest_include_rumors_label"
								class="text-base font-semibold text-heading"
							>
								🤫 Rumors
							</span>
							<GrokLogoLightIcon class="h-4.5 w-auto shrink-0 dark:hidden" aria-label="Powered by Grok" role="img" />
							<GrokLogoDarkIcon class="hidden h-4.5 w-auto shrink-0 dark:inline" aria-label="Powered by Grok" role="img" />
					</div>
						<p
							id="daily_digest_include_rumors_description"
							class="text-sm text-body-secondary mt-0.5"
						>
							Add a short rumors/chatter summary about the assets you're tracking.
						</p>
					</div>
				<div class="shrink-0">
					<label class="inline-flex items-center gap-1.5" :class="emailOnlyDisabled ? 'cursor-not-allowed' : 'cursor-pointer'">
						<input
							type="checkbox"
							v-model="includeRumorsEmail"
							:disabled="emailOnlyDisabled"
							class="rounded border-edge-strong text-teal-600 focus:ring-teal-500 h-4 w-4"
							:class="emailOnlyDisabled ? 'cursor-not-allowed' : 'cursor-pointer'"
							aria-describedby="daily_digest_include_rumors_description"
						/>
						<span class="text-sm text-label">Email</span>
					</label>
				</div>
				</div>

				</fieldset>

				<div v-if="isHydrated && nextDailyDeliveryText" class="mt-4 border-t border-edge pt-4">
					<p class="inline-flex items-center gap-2 text-sm text-body-secondary">
						<BellAlertIcon class="size-4 shrink-0 text-success-strong" aria-hidden="true" />
						<span>Next delivery <span class="font-medium text-heading">{{ nextDailyDeliveryText }}</span>.</span>
					</p>
				</div>
			</div>
		</section>
	</form>

	<!-- Daily Digest Preview -->
	<form
		ref="formatPreferencesFormElement"
		method="POST"
		action="/api/format-preferences/update"
		aria-label="Daily digest preview"
		:aria-busy="isFormatSaving"
		@input="handleFormatFormInput"
		@change="handleFormatFormChange"
		@submit="handleFormatFormSubmit"
	>
		<section class="card relative">
			<FadeTransition>
				<div
					v-if="formatStatusMessage"
					class="absolute top-3 right-3 flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium z-10 border"
					:class="STATUS_TONE_CLASSES[formatStatusTone]"
					role="status"
					aria-live="polite"
					:aria-busy="isFormatSaving"
					:data-tone="formatStatusTone"
				>
					<ArrowPathIcon
						v-show="isFormatSaving"
						class="animate-spin size-3 shrink-0"
						aria-hidden="true"
					/>
					{{ formatStatusMessage }}
				</div>
			</FadeTransition>

			<div :class="`card-accent ${CARD_GRADIENT_ACCENTS.gray}`"></div>
			<div class="card-body">
				<header class="mb-4">
					<h2 class="text-xl sm:text-2xl font-bold text-heading">
						Daily Digest Preview
					</h2>
					<p class="text-sm text-body-secondary mt-1">
						Customize how your asset notifications look. Changes apply to both SMS and email.
					</p>
				</header>

				<div
					class="transition-opacity duration-200"
					:class="{ 'opacity-50': needsChannelSelection }"
				>
					<div class="mb-6">
						<div ref="previewCarouselRef" class="preview-carousel" @scroll="onPreviewCarouselScroll">
							<div class="preview-slide">
								<SmsPreview
									:assets="previewAssets"
									:formatPreferences="formatPreferences"
								/>
							</div>
							<div class="preview-slide">
								<EmailPreview
									:assets="previewAssets"
									:formatPreferences="formatPreferences"
								/>
							</div>
						</div>
						<nav class="preview-dots" aria-label="Preview navigation">
							<button
								v-for="(label, i) in SLIDE_LABELS"
								:key="label"
								type="button"
								class="preview-dot"
								:class="{ active: activeSlide === i }"
								:aria-label="`View ${label} preview`"
								:aria-current="activeSlide === i ? 'page' : undefined"
								@click="scrollToSlide(i)"
							>
								<span class="sr-only">{{ label }}</span>
							</button>
						</nav>
						<p class="preview-hint mt-3 mb-0 text-xs text-muted italic text-center">
							Swipe left or right to switch between SMS and email previews.
						</p>
					</div>

					<SetupRequiredNotice
						:needsChannelSelection="needsChannelSelection"
						:needsPhoneVerification="false"
						phoneVerificationSectionId=""
					/>

					<FormatToggles
						:showSparklines="showSparklines"
						:showCompanyName="showCompanyName"
						:detailedFormat="detailedFormat"
						:disabled="needsChannelSelection"
						@update:showSparklines="showSparklines = $event"
						@update:showCompanyName="showCompanyName = $event"
						@update:detailedFormat="detailedFormat = $event"
					/>
				</div>
			</div>
		</section>
	</form>
	</div>
</template>

<script lang="ts" setup>
import { DateTime } from "luxon";
import { computed, onBeforeUnmount, onMounted, onUnmounted, ref, toRefs, watch } from "vue";
// ?component suffix required: Astro Icon cannot be used in Vue; vite-svg-loader compiles this to a Vue component.
import ArrowPathIcon from "../../../icons/arrow-path.svg?component";
import BellAlertIcon from "../../../icons/bell-alert.svg?component";
import FinnhubLogoIcon from "../../../icons/finnhub.svg?component";
import GrokLogoDarkIcon from "../../../icons/grok-dark.svg?component";
import GrokLogoLightIcon from "../../../icons/grok-light.svg?component";
import InformationCircleIcon from "../../../icons/information-circle-20.svg?component";
import PresentationChartLineIcon from "../../../icons/presentation-chart-line.svg?component";
import {
	CARD_GRADIENT_ACCENTS,
	DASHBOARD_DAILY_NOTIFICATIONS_FORM_ID,
	DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID,
	DASHBOARD_SECTION_IDS,
	STATUS_TONE_CLASSES,
} from "../../../lib/constants";
import type { FormatPreferences } from "../../../lib/messaging/types";
import {
	formatCountdownWithSeconds,
	formatMinutesAsLocalTime,
	getSecondsUntilNextSend,
	getUsMarketOpenLocalMinutes,
	minutesToTimeInputValue,
	parseTimeToMinutes,
} from "../../../lib/time/format";
import FadeTransition from "../../FadeTransition.vue";
import type { InitialAsset } from "../assets/types";
import {
	type FormatPreferencesData,
	useAutoSaveFormatPreferences,
} from "../composables/useAutoSaveFormatPreferences";
import {
	type NotificationPreferencesData,
	useAutoSaveForm,
} from "../composables/useAutoSaveNotificationPreferences";
import { useDashboardUser } from "../composables/useDashboardUser";
import SetupRequiredNotice from "../shared/SetupRequiredNotice.vue";
import TimePicker from "../shared/TimePicker.vue";
import EmailPreview from "./preview/EmailPreview.vue";
import FormatToggles from "./preview/FormatToggles.vue";
import { DEMO_ASSETS, type PreviewAsset } from "./preview/preview-data";
import SmsPreview from "./preview/SmsPreview.vue";

interface Props {
	initialAssets: InitialAsset[];
	emailEnabled: boolean;
	smsEnabled: boolean;
	phoneVerified: boolean;
}

const props = defineProps<Props>();
const { initialAssets, emailEnabled, smsEnabled, phoneVerified } = toRefs(props);

const user = useDashboardUser();

const smsReady = computed(() => smsEnabled.value && phoneVerified.value);
const hasNotificationChannel = computed(() => emailEnabled.value || smsReady.value);
const needsChannelSelection = computed(() => !hasNotificationChannel.value);
const needsPhoneVerification = computed(() => smsEnabled.value && !phoneVerified.value);

/** News & Rumors are email-only — disable when email channel isn't enabled */
const emailOnlyDisabled = computed(() => needsChannelSelection.value || !emailEnabled.value);
const phoneVerificationSectionId = `${DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID}-phone-verification-section`;

const isHydrated = ref(false);
const tick = ref(0);
let intervalId: number | null = null;

onMounted(() => {
	isHydrated.value = true;
	tick.value = Date.now();
	intervalId = window.setInterval(() => {
		tick.value = Date.now();
	}, 1000);

	if (dailyEnabled.value) {
		// On initial mount we may "inherit" a time from market notifications for display,
		// but we should not autosave during hydration.
		maybeDefaultToMarketTime();
	}
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

const includeNewsEmail = ref(user.value.daily_digest_include_news_email);
const includeRumorsEmail = ref(user.value.daily_digest_include_rumors_email);
const dailyDeliveryTimeMinutes = ref<number | null>(
	user.value.daily_digest_time ?? getEarliestMarketNotificationTime(),
);

const dailyEnabled = computed(() =>
	includeNewsEmail.value ||
	includeRumorsEmail.value,
);

/**
 * When the daily digest is enabled but no delivery time is set,
 * default to the earliest scheduled market notification time (if any).
 * The user can still change to a different time.
 */
function getEarliestMarketNotificationTime(): number | null {
	const times = user.value.market_scheduled_asset_price_times;
	if (!times || times.length === 0) return null;
	return Math.min(...times);
}

/**
 * If the daily digest is enabled but no explicit daily delivery time is set,
 * inherit the earliest scheduled market notification time for display (and optional save).
 */
function maybeDefaultToMarketTime(): boolean {
	if (dailyDeliveryTimeMinutes.value !== null) return false;
	const earliestMarketNotificationTime = getEarliestMarketNotificationTime();
	if (earliestMarketNotificationTime === null) return false;
	dailyDeliveryTimeMinutes.value = earliestMarketNotificationTime;
	return true;
}

const dailyDeliveryTimeInput = computed(() =>
	dailyDeliveryTimeMinutes.value !== null
		? minutesToTimeInputValue(dailyDeliveryTimeMinutes.value)
		: null,
);

const marketOpenLocalMinutes = computed(() =>
	user.value.timezone ? getUsMarketOpenLocalMinutes(user.value.timezone) : null,
);

const marketOpenLabel = computed(() =>
	marketOpenLocalMinutes.value !== null
		? formatMinutesAsLocalTime(marketOpenLocalMinutes.value, user.value.use_24_hour_time)
		: null,
);

const isMarketOpenTime = computed(() => {
	if (marketOpenLocalMinutes.value === null) return true;
	return dailyDeliveryTimeMinutes.value === marketOpenLocalMinutes.value;
});

const canSetMarketOpen = computed(
	() => !needsChannelSelection.value && !isMarketOpenTime.value,
);

/** Clear the daily digest delivery time (disables sending unless inherited elsewhere). */
function handleClearDeliveryTime() {
	if (needsChannelSelection.value) return;
	dailyDeliveryTimeMinutes.value = null;
	notifyChange();
}

/** Set the daily digest delivery time to the user's local US market-open time. */
function handleSetMarketOpen() {
	if (!canSetMarketOpen.value || marketOpenLocalMinutes.value === null) {
		return;
	}
	dailyDeliveryTimeMinutes.value = marketOpenLocalMinutes.value;
	notifyChange();
}

const nextDailyDeliveryText = computed(() => {
	if (!isHydrated.value || !dailyEnabled.value) return null;
	void tick.value;

	if (!user.value.timezone) return null;

	const secondsUntil = getSecondsUntilNextSend({
		nextSendAtIso: user.value.daily_digest_next_send_at,
		timeInput: dailyDeliveryTimeInput.value,
		timezone: user.value.timezone,
		now: DateTime.utc(),
	});
	if (secondsUntil === null) return null;
	return secondsUntil <= 0 ? "is due soon" : `in ${formatCountdownWithSeconds(secondsUntil)}`;
});

watch([includeNewsEmail, includeRumorsEmail], () => {
	notifyChange();
});

watch(dailyEnabled, (enabled) => {
	if (enabled) {
		// When a user enables the daily digest, default to market time (if needed)
		// and explicitly notify so the defaulted time is persisted.
		const didDefault = maybeDefaultToMarketTime();
		if (didDefault) {
			notifyChange();
		}
	}
});

function handleDailyTimeChange(value: string) {
	const parsed = parseTimeToMinutes(value);
	if (parsed === null) return;
	dailyDeliveryTimeMinutes.value = parsed;
	notifyChange();
}

watch(
	() => user.value.daily_digest_include_news_email,
	(value) => {
		includeNewsEmail.value = value;
	},
);
watch(
	() => user.value.daily_digest_include_rumors_email,
	(value) => {
		includeRumorsEmail.value = value;
	},
);
watch(
	() => user.value.daily_digest_time,
	(value) => {
		dailyDeliveryTimeMinutes.value = value ?? getEarliestMarketNotificationTime();
	},
);
watch(
	() => user.value.market_scheduled_asset_price_times,
	(times) => {
		if (user.value.daily_digest_time !== null) return;
		dailyDeliveryTimeMinutes.value =
			times && times.length > 0 ? getEarliestMarketNotificationTime() : null;
	},
);
/* =============
Keep dashboard user state aligned with autosave responses
============= */
watch(savedData, (newData) => {
	if (!newData) return;
	user.value = {
		...user.value,
		daily_digest_include_news_email: newData.daily_digest_include_news_email,
		daily_digest_include_rumors_email: newData.daily_digest_include_rumors_email,
		daily_digest_time: newData.daily_digest_time,
		daily_digest_next_send_at: newData.daily_digest_next_send_at,
		// Daily delivery time determines asset events delivery time, so the server
		// recalculates asset_events_next_send_at when it changes. Keep all panels'
		// scheduling in sync so countdowns update without a page refresh.
		asset_events_next_send_at: newData.asset_events_next_send_at,
		market_scheduled_asset_price_next_send_at: newData.market_scheduled_asset_price_next_send_at,
	};
});

/* =============
Format Preferences (Preview card)
============= */
const formatPreferencesFormElement = ref<HTMLFormElement | null>(null);
const {
	handleFormChange: handleFormatFormChange,
	handleFormInput: handleFormatFormInput,
	handleFormSubmit: handleFormatFormSubmit,
	isSaving: isFormatSaving,
	notifyChange: notifyFormatChange,
	statusMessage: formatStatusMessage,
	statusTone: formatStatusTone,
	savedData: formatSavedData,
} = useAutoSaveFormatPreferences<FormatPreferencesData>({
	formRef: formatPreferencesFormElement,
});

const showSparklines = ref(user.value.show_sparklines);
const showCompanyName = ref(user.value.show_company_name);
const detailedFormat = ref(user.value.detailed_format);

watch(formatSavedData, (newData) => {
	if (!newData) return;
	showSparklines.value = newData.show_sparklines;
	showCompanyName.value = newData.show_company_name;
	detailedFormat.value = newData.detailed_format;
	user.value = {
		...user.value,
		show_sparklines: newData.show_sparklines,
		show_company_name: newData.show_company_name,
		detailed_format: newData.detailed_format,
	};
});

watch([showSparklines, showCompanyName, detailedFormat], () => {
	notifyFormatChange();
});

const formatPreferences = computed<FormatPreferences>(() => ({
	show_sparklines: showSparklines.value,
	show_company_name: showCompanyName.value,
	detailed_format: detailedFormat.value,
}));

const previewAssets = computed<PreviewAsset[]>(() => {
	const assets = initialAssets.value;
	if (assets.length === 0) {
		return DEMO_ASSETS;
	}
	const demoData = [
		{ price: 195.5, changePercent: 2.4, sparkline: "▁▂▃▅▇▅▆" },
		{ price: 178.2, changePercent: 1.8, sparkline: "▃▂▁▃▅▆▇" },
		{ price: 248.3, changePercent: -0.5, sparkline: "▇▆▅▃▂▃▁" },
	];
	return assets.slice(0, 3).map((asset, i) => ({
		symbol: asset.symbol,
		name: asset.name,
		price: demoData[i % demoData.length].price,
		changePercent: demoData[i % demoData.length].changePercent,
		sparkline: demoData[i % demoData.length].sparkline,
	}));
});

// --- Preview carousel (mobile only, CSS scroll-snap) ---
const SLIDE_LABELS = ["SMS", "Email"] as const;
const previewCarouselRef = ref<HTMLElement | null>(null);
const activeSlide = ref(0);
let scrollTicking = false;

function onPreviewCarouselScroll() {
	if (scrollTicking) return;
	scrollTicking = true;
	requestAnimationFrame(() => {
		const el = previewCarouselRef.value;
		if (el && el.clientWidth > 0) {
			const index = Math.round(el.scrollLeft / el.clientWidth);
			activeSlide.value = Math.min(Math.max(index, 0), SLIDE_LABELS.length - 1);
		}
		scrollTicking = false;
	});
}

function scrollToSlide(index: number) {
	const el = previewCarouselRef.value;
	if (!el) return;
	const slide = el.children[index] as HTMLElement | undefined;
	slide?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "start" });
}

// Reset active slide when resizing from mobile to desktop
const previewMediaQuery = typeof window !== "undefined" ? window.matchMedia("(min-width: 768px)") : null;

function onPreviewMediaChange(e: MediaQueryListEvent | MediaQueryList) {
	if (e.matches) activeSlide.value = 0;
}

onMounted(() => {
	previewMediaQuery?.addEventListener("change", onPreviewMediaChange);
});

onBeforeUnmount(() => {
	previewMediaQuery?.removeEventListener("change", onPreviewMediaChange);
});
</script>

<style scoped>
/* Mobile: horizontal scroll-snap carousel */
.preview-carousel {
	display: flex;
	overflow-x: auto;
	scroll-snap-type: x mandatory;
	-webkit-overflow-scrolling: touch;
	scrollbar-width: none; /* Firefox */
	gap: 1.5rem;
}

.preview-carousel::-webkit-scrollbar {
	display: none; /* Chrome / Safari */
}

.preview-slide {
	scroll-snap-align: start;
	flex: 0 0 100%;
	min-width: 0;
}

/* Dot navigation (mobile only) */
.preview-dots {
	display: flex;
	justify-content: center;
	gap: 0.5rem;
	margin-top: 0.75rem;
}

.preview-dot {
	width: 0.5rem;
	height: 0.5rem;
	border-radius: 9999px;
	border: none;
	padding: 0;
	cursor: pointer;
	background: var(--color-edge-strong);
	transition: background-color 0.2s, transform 0.2s;
}

.preview-dot.active {
	background: #6366f1; /* indigo-500 */
	transform: scale(1.25);
}

.preview-hint {
	display: block;
}

/* Desktop (md+): side-by-side grid, hide dots */
@media (min-width: 768px) {
	.preview-carousel {
		display: grid;
		grid-template-columns: 1fr 1fr;
		overflow: visible;
		scroll-snap-type: none;
	}

	.preview-slide {
		flex: initial;
	}

	.preview-dots {
		display: none;
	}

	.preview-hint {
		display: none;
	}
}
</style>
