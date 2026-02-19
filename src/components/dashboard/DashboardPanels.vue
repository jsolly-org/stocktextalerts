<template>
	<DashboardCarousel v-model:activeIndex="activeIndex">
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
					:initialAssets="initialAssets"
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
				v-model:emailEnabled="emailEnabled"
				:sms-phone-number="smsPhoneNumber"
			/>
		</template>

		<template #daily>
			<AsyncDailyNotificationsPanel
				v-if="shouldRender(2)"
				:initialAssets="currentAssets"
				:emailEnabled="emailEnabled"
				:phoneVerified="phoneVerified"
				:hasTrackedAssets="hasTrackedAssets"
			/>
		</template>

		<template #market-notifications>
			<AsyncMarketNotificationsPanel
				v-if="shouldRender(3)"
				:emailEnabled="emailEnabled"
				:phoneVerified="phoneVerified"
				:hasTrackedAssets="hasTrackedAssets"
				:trackedAssets="currentAssets"
			/>
		</template>

		<template #asset-events>
			<AsyncAssetEventsPanel
				v-if="shouldRender(4)"
				:emailEnabled="emailEnabled"
				:phoneVerified="phoneVerified"
				:hasTrackedAssets="hasTrackedAssets"
			/>
		</template>
	</DashboardCarousel>
</template>

<script lang="ts" setup>
import { useMediaQuery } from "@vueuse/core";
import { computed, defineAsyncComponent, ref, toRefs, watch } from "vue";
import {
	DASHBOARD_ASSETS_FORM_ID,
} from "../../lib/constants";
import type { User } from "../../lib/db";
import type { InitialAsset } from "./assets/types";
import WatchlistPanel from "./assets/WatchlistPanel.vue";
import { useAutoSaveForm } from "./composables/useAutoSaveNotificationPreferences";
import { provideDashboardUser } from "./composables/useDashboardUser";
import DashboardCarousel from "./DashboardCarousel.vue";
import PanelSkeleton from "./PanelSkeleton.vue";

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
const AsyncAssetEventsPanel = defineAsyncComponent({
	loader: () => import("./asset-events/AssetEventsPanel.vue"),
	loadingComponent: PanelSkeleton,
});
const AsyncMarketNotificationsPanel = defineAsyncComponent({
	loader: () => import("./market-notifications/MarketNotificationsPanel.vue"),
	loadingComponent: PanelSkeleton,
});

interface Props {
	user: User;
	initialAssets: InitialAsset[];
	smsPhoneNumber: string;
}

const props = defineProps<Props>();

const {
	initialAssets,
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

watch(activeIndex, (i) => visitedIndices.value.add(i));

// When switching to desktop, mark all panels as visited so they stay mounted on resize back to mobile
watch(isMobile, (mobile) => {
	if (!mobile) for (let i = 0; i < 5; i++) visitedIndices.value.add(i);
}, { immediate: true });

function shouldRender(panelIndex: number): boolean {
	if (!isMobile.value) return true;
	return visitedIndices.value.has(panelIndex);
}
</script>
