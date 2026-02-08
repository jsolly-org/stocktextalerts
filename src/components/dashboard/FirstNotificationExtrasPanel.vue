<template>
	<form
		ref="extrasFormElement"
		:id="DASHBOARD_FIRST_NOTIFICATION_EXTRAS_FORM_ID"
		method="POST"
		action="/api/notification-preferences/update"
		class="space-y-6"
		aria-label="First notification add-ons"
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

			<div :class="`h-1 ${CARD_GRADIENT_ACCENTS.teal}`"></div>
			<div class="card-body">
				<header class="mb-4">
					<h2
						:id="DASHBOARD_SECTION_IDS.firstNotificationExtras"
						class="text-xl sm:text-2xl font-bold text-gray-900"
					>
						First Notification Add-ons
					</h2>
					<p class="text-sm text-gray-600 mt-1">
						Include extra info in the first scheduled notification you get each day.
					</p>
				</header>

				<fieldset class="divide-y divide-gray-100">
					<legend class="sr-only">First notification add-ons</legend>

					<div class="flex items-center justify-between gap-3 py-3">
						<input
							type="hidden"
							name="first_notification_include_news"
							:value="includeNews ? 'on' : 'off'"
						/>
						<div class="min-w-0">
							<div class="flex items-center gap-2">
								<span
									id="first_notification_include_news_label"
									class="text-base font-semibold text-gray-900"
								>
									🗞️ News
								</span>
								<GrokLogoIcon class="h-[1.125rem] w-auto shrink-0" aria-label="Powered by Grok" role="img" />
							</div>
							<p
								id="first_notification_include_news_description"
								class="text-sm text-gray-600 mt-0.5"
							>
								Add a short news summary about the stocks you’re tracking.
							</p>
						</div>
						<ToggleSwitch
							v-model="includeNews"
							sr-label="Include news 🗞️"
							aria-labelledby="first_notification_include_news_label"
							aria-describedby="first_notification_include_news_description"
						/>
					</div>

					<div class="flex items-center justify-between gap-3 py-3">
						<input
							type="hidden"
							name="first_notification_include_rumors"
							:value="includeRumors ? 'on' : 'off'"
						/>
						<div class="min-w-0">
							<div class="flex items-center gap-2">
								<span
									id="first_notification_include_rumors_label"
									class="text-base font-semibold text-gray-900"
								>
									🤫 Rumors
								</span>
								<GrokLogoIcon class="h-[1.125rem] w-auto shrink-0" aria-label="Powered by Grok" role="img" />
							</div>
							<p
								id="first_notification_include_rumors_description"
								class="text-sm text-gray-600 mt-0.5"
							>
								Add a short rumors/chatter summary about the stocks you’re tracking.
							</p>
						</div>
						<ToggleSwitch
							v-model="includeRumors"
							sr-label="Include rumors 🤫"
							aria-labelledby="first_notification_include_rumors_label"
							aria-describedby="first_notification_include_rumors_description"
						/>
					</div>
				</fieldset>

				<div v-if="isHydrated && nextAddOnsDeliveryText" class="mt-4 border-t border-gray-200 pt-4">
					<p class="inline-flex items-center gap-2 text-sm text-gray-600">
						<BellAlertIcon class="size-4 shrink-0 text-success-strong" aria-hidden="true" />
						<span>Next delivery <span class="font-medium text-gray-900">{{ nextAddOnsDeliveryText }}</span>.</span>
					</p>
				</div>
			</div>
		</section>
	</form>
</template>

<script lang="ts" setup>
import { DateTime } from "luxon";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
// ?component suffix required: Astro Icon cannot be used in Vue; vite-svg-loader compiles this to a Vue component.
import ArrowPathIcon from "../../icons/arrow-path.svg?component";
import BellAlertIcon from "../../icons/bell-alert.svg?component";
import GrokLogoIcon from "../../icons/grok.svg?component";
import {
	CARD_GRADIENT_ACCENTS,
	DASHBOARD_FIRST_NOTIFICATION_EXTRAS_FORM_ID,
	DASHBOARD_SECTION_IDS,
	STATUS_TONE_CLASSES,
} from "../../lib/constants";
import { formatCountdownWithSeconds } from "../../lib/time/format";
import { calculateNextSendAtFromTimes } from "../../lib/time/scheduled-times";
import FadeTransition from "../FadeTransition.vue";
import ToggleSwitch from "../ToggleSwitch.vue";
import {
	type NotificationPreferencesData,
	useAutoSaveForm,
} from "./composables/useAutoSaveNotificationPreferences";
import { useDashboardUser } from "./composables/useDashboardUser";

const user = useDashboardUser();

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

const includeNews = ref(user.value.first_notification_include_news);
const includeRumors = ref(user.value.first_notification_include_rumors);

const addOnsEnabled = computed(() => includeNews.value || includeRumors.value);

const nextAddOnsDeliveryText = computed(() => {
	if (!isHydrated.value) {
		return null;
	}
	void tick.value;

	if (!addOnsEnabled.value) {
		return null;
	}
	if (!user.value.scheduled_updates_enabled) {
		return null;
	}
	const times = user.value.scheduled_update_times;
	if (!times || times.length === 0) {
		return null;
	}
	const tz = user.value.timezone ?? "";
	if (tz === "") {
		return null;
	}

	const nowUtc = DateTime.utc();
	const lastIso = user.value.last_grok_rumors_at;
	const gateUtc = lastIso
		? DateTime.fromISO(lastIso, { zone: "utc" }).plus({ hours: 24 })
		: null;
	const anchorUtc =
		gateUtc?.isValid && gateUtc > nowUtc ? gateUtc : nowUtc;

	const nextEligibleUtc = calculateNextSendAtFromTimes(times, tz, anchorUtc);
	if (!nextEligibleUtc) {
		return null;
	}

	const secondsUntil = Math.ceil(nextEligibleUtc.diff(nowUtc, "seconds").seconds);
	if (!Number.isFinite(secondsUntil)) {
		return null;
	}
	if (secondsUntil <= 0) {
		return "is due soon";
	}
	return `in ${formatCountdownWithSeconds(secondsUntil)}`;
});

// ToggleSwitch is a <button>, so it does not emit native input/change events.
watch([includeNews, includeRumors], () => {
	notifyChange();
});

watch(
	() => user.value.first_notification_include_news,
	(value) => {
		includeNews.value = value;
	},
);
watch(
	() => user.value.first_notification_include_rumors,
	(value) => {
		includeRumors.value = value;
	},
);

// Update shared user ref directly when auto-save response arrives
watch(
	() => savedData.value,
	(newData) => {
		if (!newData) {
			return;
		}
		user.value = {
			...user.value,
			first_notification_include_news: newData.first_notification_include_news,
			first_notification_include_rumors:
				newData.first_notification_include_rumors,
		};
	},
);
</script>

