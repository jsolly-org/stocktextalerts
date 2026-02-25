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
		<input
			v-if="shouldSubmitDailyDigestTime"
			type="hidden"
			name="daily_digest_time"
			:value="dailyDigestTimeInputForSubmit ?? ''"
		/>
		<section class="card relative">
			<FadeTransition>
				<div
					v-if="statusMessage && statusTone === 'error'"
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
				Everything you enable below is bundled into <strong class="font-semibold text-label">one daily message</strong> sent at your daily digest <a href="#daily_digest_time" class="font-medium text-primary underline rounded-sm hover:text-primary-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1">delivery time</a>.
			</p>
			</header>

		<SetupRequiredNotice
			:needsTrackedAssets="needsTrackedAssets"
			:needsChannelSelection="needsChannelSelection"
			:needsPhoneVerification="needsPhoneVerification"
			:phoneVerificationSectionId="phoneVerificationSectionId"
		/>

	<fieldset
			class="divide-y divide-divider transition-opacity duration-200"
				:class="{ 'opacity-50': notificationSetupBlocked }"
				:disabled="isSaving"
				:aria-disabled="notificationSetupBlocked ? 'true' : undefined"
			>
					<legend class="sr-only">Daily digest settings</legend>

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
						<MassiveLogoIcon class="h-4.5 w-auto shrink-0" aria-label="Powered by Massive" role="img" />
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
					v-if="formatStatusMessage && formatStatusTone === 'error'"
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
						Notification Preview
					</h2>
					<p class="text-sm text-body-secondary mt-1">
						Customize how your asset notifications look. Changes apply to both SMS and email.
					</p>
				</header>

				<div
					class="transition-opacity duration-200"
					:class="{ 'opacity-50': notificationSetupBlocked }"
				>
					<div class="mb-6">
						<div ref="previewCarouselRef" class="preview-carousel" data-horizontal-scroll @scroll="onPreviewCarouselScroll">
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
						:needsTrackedAssets="needsTrackedAssets"
						:needsChannelSelection="needsChannelSelection"
						:needsPhoneVerification="false"
						phoneVerificationSectionId=""
					/>

					<FormatToggles
						:showSparklines="showSparklines"
						:disabled="notificationSetupBlocked"
						@update:showSparklines="handleShowSparklinesUpdate"
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
import GrokLogoDarkIcon from "../../../icons/grok-dark.svg?component";
import GrokLogoLightIcon from "../../../icons/grok-light.svg?component";
import MassiveLogoIcon from "../../../icons/massive.svg?component";
import { getScrollBehavior } from "../../../lib/accessibility";
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
	getSecondsUntilNextSend,
	minutesToTimeInputValue,
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
import EmailPreview from "./preview/EmailPreview.vue";
import FormatToggles from "./preview/FormatToggles.vue";
import { DEMO_ASSETS, type PreviewAsset } from "./preview/preview-data";
import SmsPreview from "./preview/SmsPreview.vue";

interface Props {
	initialAssets: InitialAsset[];
	emailEnabled: boolean;
	phoneVerified: boolean;
	hasTrackedAssets: boolean;
}

const props = defineProps<Props>();
const { initialAssets, emailEnabled, phoneVerified, hasTrackedAssets } =
	toRefs(props);

const user = useDashboardUser();

const smsOptedOut = computed(() => user.value.sms_opted_out === true);
const smsNotificationsEnabled = computed(() => user.value.sms_notifications_enabled === true);
const smsReady = computed(
	() => phoneVerified.value && !smsOptedOut.value && smsNotificationsEnabled.value,
);
const hasAnySmsFeatureEnabled = computed(
	() =>
		user.value.market_scheduled_asset_price_include_sms ||
		user.value.asset_events_include_calendar_sms ||
		user.value.asset_events_include_ipo_sms ||
		user.value.asset_events_include_analyst_sms ||
		user.value.asset_events_include_insider_sms ||
		user.value.market_asset_price_alerts_include_sms,
);
const hasNotificationChannel = computed(
	() => emailEnabled.value || (smsReady.value && hasAnySmsFeatureEnabled.value),
);
const needsChannelSelection = computed(() => !hasNotificationChannel.value);
const needsTrackedAssets = computed(() => !hasTrackedAssets.value);
const notificationSetupBlocked = computed(
	() => needsChannelSelection.value || needsTrackedAssets.value,
);
const needsPhoneVerification = computed(
	() => hasAnySmsFeatureEnabled.value && !phoneVerified.value,
);

function handleShowSparklinesUpdate(value: boolean) {
	showSparklines.value = value;
}

/** News & Rumors are email-only — disable when email channel isn't enabled */
const emailOnlyDisabled = computed(
	() => notificationSetupBlocked.value || !emailEnabled.value,
);
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

const dailyEnabled = computed(() =>
	includeNewsEmail.value ||
	includeRumorsEmail.value,
);

const hasAnyAssetEventsOptionEnabled = computed(
	() =>
		user.value.asset_events_include_calendar_email ||
		user.value.asset_events_include_calendar_sms ||
		user.value.asset_events_include_ipo_email ||
		user.value.asset_events_include_ipo_sms ||
		user.value.asset_events_include_analyst_email ||
		user.value.asset_events_include_analyst_sms ||
		user.value.asset_events_include_insider_email ||
		user.value.asset_events_include_insider_sms,
);

/** Derive the current delivery time input from the shared user state (managed by NotificationChannelsPanel). */
const dailyDeliveryTimeInput = computed(() => {
	const minutes = user.value.daily_digest_time;
	return minutes !== null && minutes !== undefined
		? minutesToTimeInputValue(minutes)
		: null;
});

function getEarliestMarketNotificationTime(): number | null {
	const times = user.value.market_scheduled_asset_price_times;
	if (!times || times.length === 0) return null;
	return Math.min(...times);
}

/**
 * Ensure daily-digest saves include a delivery time even when the Alerts panel
 * hasn't mounted yet (mobile lazy tabs).
 */
const lastKnownDailyDeliveryTimeInput = ref<string | null>(null);
watch(
	dailyDeliveryTimeInput,
	(value) => {
		if (value !== null) lastKnownDailyDeliveryTimeInput.value = value;
	},
	{ immediate: true },
);

const dailyDigestTimeInputForSubmit = computed(() => {
	if (dailyDeliveryTimeInput.value !== null) return dailyDeliveryTimeInput.value;
	if (!dailyEnabled.value) {
		// When daily is disabled but asset events are enabled, keep submitting the
		// prior delivery time so this form doesn't accidentally clear
		// `daily_digest_time` (asset-events scheduling uses it as a fallback).
		return hasAnyAssetEventsOptionEnabled.value
			? lastKnownDailyDeliveryTimeInput.value
			: null;
	}
	const fallbackMinutes = getEarliestMarketNotificationTime();
	return fallbackMinutes !== null
		? minutesToTimeInputValue(fallbackMinutes)
		: null;
});

const shouldClearDailyDigestTimeOnSubmit = computed(
	() => !dailyEnabled.value && !hasAnyAssetEventsOptionEnabled.value,
);
const shouldSubmitDailyDigestTime = computed(
	() =>
		dailyEnabled.value ||
		dailyDigestTimeInputForSubmit.value !== null ||
		shouldClearDailyDigestTimeOnSubmit.value,
);

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

watch(formatSavedData, (newData) => {
	if (!newData) return;
	showSparklines.value = newData.show_sparklines;
	user.value = {
		...user.value,
		show_sparklines: newData.show_sparklines,
	};
});

watch([showSparklines], () => {
	notifyFormatChange();
});

const formatPreferences = computed<FormatPreferences>(() => ({
	show_sparklines: showSparklines.value,
}));

const previewAssets = computed<PreviewAsset[]>(() => {
	const assets = initialAssets.value;
	if (assets.length === 0) {
		return DEMO_ASSETS;
	}
	const demoData = [
		{ price: 195.5, changePercent: 2.4, sparkline: "▁▂▃▅▇▅▆", sparklineValues: [188, 190, 191, 193, 196, 194, 195] },
		{ price: 178.2, changePercent: 1.8, sparkline: "▃▂▁▃▅▆▇", sparklineValues: [174, 173, 172, 174, 176, 177, 178] },
		{ price: 248.3, changePercent: -0.5, sparkline: "▇▆▅▃▂▃▁", sparklineValues: [255, 253, 252, 250, 249, 250, 248] },
	];
	return assets.slice(0, 3).map((asset, i) => ({
		symbol: asset.symbol,
		name: asset.name,
		price: demoData[i % demoData.length].price,
		changePercent: demoData[i % demoData.length].changePercent,
		sparkline: demoData[i % demoData.length].sparkline,
		sparklineValues: demoData[i % demoData.length].sparklineValues,
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
	slide?.scrollIntoView({ behavior: getScrollBehavior(), block: "nearest", inline: "start" });
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
	/* Override the parent carousel's touch-action: pan-y so the browser
	   allows native horizontal scrolling on this element. */
	touch-action: pan-x pan-y;
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
