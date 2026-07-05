<template>
	<DashboardCarousel v-model:active-index="activeIndex">
		<template #setup>
			<form
				ref="assetsFormElement"
				:id="DASHBOARD_ASSETS_FORM_ID"
				method="POST"
				action="/api/assets/update"
				aria-label="Watchlist"
				:aria-busy="isAssetsSaving"
				@input="handleAssetsFormInput"
				@change="handleAssetsFormChange"
				@submit="handleAssetsFormSubmit"
			>
				<WatchlistPanel
					:initial-assets="initialAssets"
					:status-message="assetsStatusMessage"
					:status-tone="assetsStatusTone"
					:is-saving="isAssetsSaving"
					@form-changed="notifyAssetsChange"
					@assets-changed="handleAssetsChanged"
				/>
			</form>
		</template>

		<template #schedule>
			<AsyncNotificationChannelsPanel
				v-if="shouldRender(1)"
				v-model:email-enabled="emailEnabled"
				:sms-phone-number="smsPhoneNumber"
				:initial-assets="currentAssets"
				:has-tracked-assets="hasTrackedAssets"
			/>
		</template>

		<template #daily>
			<AsyncDailyNotificationsPanel
				v-if="shouldRender(2)"
				:email-enabled="emailEnabled"
				:phone-verified="phoneVerified"
				:has-tracked-assets="hasTrackedAssets"
				:telegram-prefs="dailyDigestTelegramPrefs"
				:asset-event-telegram-prefs="assetEventsTelegramPrefs"
			/>
		</template>

		<template #market-notifications>
			<AsyncMarketNotificationsPanel
				v-if="shouldRender(3)"
				:email-enabled="emailEnabled"
				:phone-verified="phoneVerified"
				:has-tracked-assets="hasTrackedAssets"
				:tracked-assets="currentAssets"
				:price-move-thresholds="priceMoveThresholds"
				:telegram-prefs="marketTelegramPrefs"
			/>
		</template>

	</DashboardCarousel>
</template>

<script lang="ts" setup>
import { useMediaQuery } from "@vueuse/core";
import { computed, defineAsyncComponent, ref, toRefs, watch } from "vue";
import type { DashboardUser } from "../../lib/db/types";
import { useHydrated } from "../useHydrated";
import WatchlistPanel from "./assets/WatchlistPanel.vue";
import { useAutoSaveForm } from "./composables/useAutoSaveNotificationPreferences";
import { provideDashboardUser } from "./composables/useDashboardUser";
import { DASHBOARD_ASSETS_FORM_ID } from "./constants";
import DashboardCarousel from "./DashboardCarousel.vue";
import PanelSkeleton from "./PanelSkeleton.vue";
import type { InitialAsset, PriceMoveThresholdMap } from "./types";

// Lazy-load panels 2-5 so mobile only fetches the chunk when the tab is visited.
// On desktop all loaders fire immediately in parallel (shouldRender returns true for all).
const AsyncNotificationChannelsPanel = defineAsyncComponent({
	loader: () => import("./notification-channels/NotificationChannelsPanel.vue"),
	loadingComponent: PanelSkeleton,
});
const AsyncDailyNotificationsPanel = defineAsyncComponent({
	loader: () => import("./daily-digest/DailyNotificationsPanel.vue"),
	loadingComponent: PanelSkeleton,
});
const AsyncMarketNotificationsPanel = defineAsyncComponent({
	loader: () => import("./market-notifications/MarketNotificationsPanel.vue"),
	loadingComponent: PanelSkeleton,
});
interface Props {
	user: DashboardUser;
	initialAssets: InitialAsset[];
	smsPhoneNumber: string;
	/**
	 * The user's current Telegram selections, loaded server-side from
	 * `notification_preferences` (channel='telegram') since these prefs aren't on the
	 * users row. Each panel gets its relevant subset to initialize its channel
	 * multiselect:
	 * - daily_digest / asset_events: keyed by content facet ("prices", "calendar", …).
	 * - market types: keyed by notification_type (content='').
	 */
	dailyDigestTelegramPrefs: Record<string, boolean>;
	assetEventsTelegramPrefs: Record<string, boolean>;
	marketTelegramPrefs: Record<string, boolean>;
	/** Per-symbol price-move alert thresholds, loaded server-side. */
	priceMoveThresholds: PriceMoveThresholdMap;
}

const props = defineProps<Props>();

const {
	assetEventsTelegramPrefs,
	dailyDigestTelegramPrefs,
	initialAssets,
	marketTelegramPrefs,
	priceMoveThresholds,
	smsPhoneNumber,
	user: userProp,
} = toRefs(props);

// Shared mutable user ref — all dashboard descendants inject this via useDashboardUser()
const dashboardUser = provideDashboardUser(userProp);

// Live tracked assets — starts from server data, updated by WatchlistPanel edits
const currentAssets = ref<InitialAsset[]>([...props.initialAssets]);
const hasTrackedAssets = computed(() => currentAssets.value.length > 0);

const emailEnabled = ref(dashboardUser.value.email_notifications_enabled);
const phoneVerified = computed(() => dashboardUser.value.phone_verified);

// Sync channel flags when user changes (e.g., after auto-save response)
watch(
	() => dashboardUser.value.email_notifications_enabled,
	(value) => {
		emailEnabled.value = value;
	},
);

function handleAssetsChanged(assets: InitialAsset[]) {
	currentAssets.value = assets;
}

// --- Assets form (unchanged, future refactor candidate) ---
const assetsFormElement = ref<HTMLFormElement | null>(null);
const {
	handleFormChange: handleAssetsFormChange,
	handleFormInput: handleAssetsFormInput,
	handleFormSubmit: handleAssetsFormSubmit,
	isSaving: isAssetsSaving,
	notifyChange: notifyAssetsChange,
	statusMessage: assetsStatusMessage,
	statusTone: assetsStatusTone,
} = useAutoSaveForm({
	formRef: assetsFormElement,
});

// --- Mobile lazy-loading ---
const isMobile = useMediaQuery("(max-width: 767.99px)");
const activeIndex = ref(0);
const visitedIndices = ref(new Set<number>([0]));
// `isMobile` is always false during SSR but reflects the real viewport on the
// client, so gating panels on it during the initial render makes the client's
// hydration render diverge from the server markup on narrow viewports (Vue:
// "Server rendered element contains more child nodes than client vdom"). Match
// SSR by rendering every panel until mounted, then apply the lazy-load gating.
const isHydrated = useHydrated();

watch(activeIndex, (i) => visitedIndices.value.add(i));

// When switching to desktop, mark all panels as visited so they stay mounted on resize back to mobile
watch(isMobile, (mobile) => {
	if (!mobile) for (let i = 0; i < 4; i++) visitedIndices.value.add(i);
}, { immediate: true });

function shouldRender(panelIndex: number): boolean {
	if (!isHydrated.value) return true;
	if (!isMobile.value) return true;
	return visitedIndices.value.has(panelIndex);
}
</script>
