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
				:initial-assets="currentAssets"
				:has-tracked-assets="hasTrackedAssets"
			/>
		</template>

		<template #daily>
			<AsyncDailyNotificationsPanel
				v-if="shouldRender(2)"
				:has-tracked-assets="hasTrackedAssets"
			/>
		</template>

		<template #market-notifications>
			<AsyncMarketNotificationsPanel
				v-if="shouldRender(3)"
				:has-tracked-assets="hasTrackedAssets"
				:tracked-assets="currentAssets"
				:price-move-thresholds="priceMoveThresholds"
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
	priceMoveThresholds: PriceMoveThresholdMap;
}

const props = defineProps<Props>();

const { initialAssets, priceMoveThresholds, user: userProp } = toRefs(props);

const dashboardUser = provideDashboardUser(userProp);

const currentAssets = ref<InitialAsset[]>([...props.initialAssets]);
const hasTrackedAssets = computed(() => currentAssets.value.length > 0);

function handleAssetsChanged(assets: InitialAsset[]) {
	currentAssets.value = assets;
}

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

const isMobile = useMediaQuery("(max-width: 767.99px)");
const activeIndex = ref(0);
const visitedIndices = ref(new Set<number>([0]));
const isHydrated = useHydrated();

watch(activeIndex, (i) => visitedIndices.value.add(i));

watch(
	isMobile,
	(mobile) => {
		if (!mobile) for (let i = 0; i < 4; i++) visitedIndices.value.add(i);
	},
	{ immediate: true },
);

function shouldRender(panelIndex: number): boolean {
	if (!isHydrated.value) return true;
	if (!isMobile.value) return true;
	return visitedIndices.value.has(panelIndex);
}

// Keep TypeScript from flagging unused inject when panels aren't yet visited.
void dashboardUser;
</script>
