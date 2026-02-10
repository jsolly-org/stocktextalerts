<template>
	<form
		ref="formatPreferencesFormElement"
		:id="DASHBOARD_FORMAT_PREFERENCES_FORM_ID"
		method="POST"
		action="/api/format-preferences/update"
		aria-label="Format preferences"
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

			<div :class="`card-accent ${CARD_GRADIENT_ACCENTS.gray}`"></div>
			<div class="card-body">
				<header class="mb-4">
					<h2
						:id="DASHBOARD_SECTION_IDS.preview"
						class="text-xl sm:text-2xl font-bold text-gray-900"
					>
						Notification Preview
					</h2>
					<p class="text-sm text-gray-600 mt-1">
						Customize how your asset notifications look. Changes apply to both SMS and email.
					</p>
				</header>

				<SetupRequiredNotice
					:needsChannelSelection="needsChannelSelection"
					:needsPhoneVerification="false"
					phoneVerificationSectionId=""
				/>

			<div
				class="transition-opacity duration-200"
				:class="{ 'opacity-50': needsChannelSelection }"
			>
			<FormatToggles
				:showChangePercent="showChangePercent"
				:showCompanyName="showCompanyName"
				:detailedFormat="detailedFormat"
				:disabled="needsChannelSelection"
				@update:showChangePercent="showChangePercent = $event"
				@update:showCompanyName="showCompanyName = $event"
				@update:detailedFormat="detailedFormat = $event"
			/>

			<p class="preview-hint mt-6 mb-0 text-xs text-gray-500 italic text-center">
				Swipe left or right to switch between SMS and email previews.
			</p>

		<div class="mt-4">
			<div ref="carouselRef" class="preview-carousel" @scroll="onCarouselScroll">
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
					:aria-current="activeSlide === i ? 'true' : undefined"
					@click="scrollToSlide(i)"
				>
					<span class="sr-only">{{ label }}</span>
				</button>
			</nav>
		</div>
			</div>
		</div>
		</section>
	</form>
</template>

<script lang="ts" setup>
import { computed, onBeforeUnmount, onMounted, ref, toRefs, watch } from "vue";
// ?component suffix required: Astro Icon cannot be used in Vue; vite-svg-loader compiles this to a Vue component.
import ArrowPathIcon from "../../../icons/arrow-path.svg?component";
import {
	CARD_GRADIENT_ACCENTS,
	DASHBOARD_FORMAT_PREFERENCES_FORM_ID,
	DASHBOARD_SECTION_IDS,
	STATUS_TONE_CLASSES,
} from "../../../lib/constants";
import type { FormatPreferences } from "../../../lib/messaging/types";
import FadeTransition from "../../FadeTransition.vue";
import type { InitialAsset } from "../assets/types";
import {
	type FormatPreferencesData,
	useAutoSaveFormatPreferences,
} from "../composables/useAutoSaveFormatPreferences";
import { useDashboardUser } from "../composables/useDashboardUser";
import SetupRequiredNotice from "../scheduled-notifications/SetupRequiredNotice.vue";
import EmailPreview from "./EmailPreview.vue";
import FormatToggles from "./FormatToggles.vue";
import { DEMO_ASSETS, type PreviewAsset } from "./preview-data";
import SmsPreview from "./SmsPreview.vue";

interface Props {
	initialAssets: InitialAsset[];
	emailEnabled: boolean;
	smsEnabled: boolean;
	phoneVerified: boolean;
}

const props = defineProps<Props>();

const { initialAssets, emailEnabled, smsEnabled, phoneVerified } = toRefs(props);

// Inject the shared mutable user ref from DashboardPanels
const user = useDashboardUser();

const smsReady = computed(() => smsEnabled.value && phoneVerified.value);
const hasNotificationChannel = computed(() => emailEnabled.value || smsReady.value);
const needsChannelSelection = computed(() => !hasNotificationChannel.value);

const formatPreferencesFormElement = ref<HTMLFormElement | null>(null);
const {
	handleFormChange,
	handleFormInput,
	handleFormSubmit,
	isSaving,
	notifyChange,
	statusMessage,
	statusTone,
} = useAutoSaveFormatPreferences<FormatPreferencesData>({
	formRef: formatPreferencesFormElement,
});

const showChangePercent = ref(user.value.show_change_percent);
const showCompanyName = ref(user.value.show_company_name);
const detailedFormat = ref(user.value.detailed_format);

// ToggleSwitch is a <button>, so it does not emit native input/change events.
// Watch the reactive toggle values and notify the autosave composable directly.
watch([showChangePercent, showCompanyName, detailedFormat], () => {
	notifyChange();
});

const formatPreferences = computed<FormatPreferences>(() => ({
	show_change_percent: showChangePercent.value,
	show_company_name: showCompanyName.value,
	detailed_format: detailedFormat.value,
}));

const previewAssets = computed<PreviewAsset[]>(() => {
	const assets = initialAssets.value;
	if (assets.length === 0) {
		return DEMO_ASSETS;
	}
	const demoPrices = [
		{ price: 195.5, changePercent: 2.4 },
		{ price: 178.2, changePercent: 1.8 },
		{ price: 248.3, changePercent: -0.5 },
	];
	return assets.slice(0, 3).map((asset, i) => ({
		symbol: asset.symbol,
		name: asset.name,
		price: demoPrices[i % demoPrices.length].price,
		changePercent: demoPrices[i % demoPrices.length].changePercent,
	}));
});

// --- Carousel (mobile only, CSS scroll-snap) ---
const SLIDE_LABELS = ["SMS", "Email"] as const;
const carouselRef = ref<HTMLElement | null>(null);
const activeSlide = ref(0);

/** Detect which slide is in view by checking scroll position. */
function onCarouselScroll() {
	const el = carouselRef.value;
	if (!el) return;
	const index = Math.round(el.scrollLeft / el.clientWidth);
	activeSlide.value = Math.min(Math.max(index, 0), SLIDE_LABELS.length - 1);
}

function scrollToSlide(index: number) {
	const el = carouselRef.value;
	if (!el) return;
	const slide = el.children[index] as HTMLElement | undefined;
	slide?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "start" });
}

// Reset active slide when resizing from mobile to desktop
const mediaQuery = typeof window !== "undefined" ? window.matchMedia("(min-width: 768px)") : null;

function onMediaChange(e: MediaQueryListEvent | MediaQueryList) {
	if (e.matches) activeSlide.value = 0;
}

onMounted(() => {
	mediaQuery?.addEventListener("change", onMediaChange);
});

onBeforeUnmount(() => {
	mediaQuery?.removeEventListener("change", onMediaChange);
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
	background: #d1d5db; /* gray-300 */
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
