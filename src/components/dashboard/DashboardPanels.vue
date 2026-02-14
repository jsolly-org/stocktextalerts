<template>
	<DashboardCarousel>
		<template #setup>
			<div class="space-y-6">
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
						@assets-changed="currentAssets = $event"
					/>
				</form>

				<NotificationChannelsPanel
					v-model:emailEnabled="emailEnabled"
					v-model:smsEnabled="smsEnabled"
				/>
			</div>
		</template>

		<template #schedule>
			<MarketNotificationsPanel
				:emailEnabled="emailEnabled"
				:smsEnabled="smsEnabled"
				:phoneVerified="phoneVerified"
			/>
		</template>

		<template #daily>
			<DailyNotificationsPanel
				:initialAssets="currentAssets"
				:emailEnabled="emailEnabled"
				:smsEnabled="smsEnabled"
				:phoneVerified="phoneVerified"
			/>
		</template>

		<template #asset-events>
			<AssetEventsPanel
				:emailEnabled="emailEnabled"
				:smsEnabled="smsEnabled"
				:phoneVerified="phoneVerified"
			/>
		</template>
	</DashboardCarousel>
</template>

<script lang="ts" setup>
import { computed, ref, toRefs, watch } from "vue";
import {
	DASHBOARD_ASSETS_FORM_ID,
} from "../../lib/constants";
import type { User } from "../../lib/db";
import AssetEventsPanel from "./asset-events/AssetEventsPanel.vue";
import type { InitialAsset } from "./assets/types";
import WatchlistPanel from "./assets/WatchlistPanel.vue";
import { useAutoSaveForm } from "./composables/useAutoSaveNotificationPreferences";
import { provideDashboardUser } from "./composables/useDashboardUser";
import DashboardCarousel from "./DashboardCarousel.vue";
import DailyNotificationsPanel from "./daily-digest/DailyNotificationsPanel.vue";
import MarketNotificationsPanel from "./market-notifications/MarketNotificationsPanel.vue";
import NotificationChannelsPanel from "./notification-channels/NotificationChannelsPanel.vue";

interface Props {
	user: User;
	initialAssets: InitialAsset[];
}

const props = defineProps<Props>();

const {
	initialAssets,
	user: userProp,
} = toRefs(props);

// Shared mutable user ref — all dashboard descendants inject this via useDashboardUser()
const user = provideDashboardUser(userProp);

// Live tracked assets — starts from server data, updated by WatchlistPanel edits
const currentAssets = ref<InitialAsset[]>([...props.initialAssets]);

const emailEnabled = ref(user.value.email_notifications_enabled);
const smsEnabled = ref(user.value.sms_notifications_enabled);
const phoneVerified = computed(() => user.value.phone_verified);

// Sync channel flags when user changes (e.g., after auto-save response)
watch(
	() => user.value.email_notifications_enabled,
	(value) => {
		emailEnabled.value = value;
	},
);
watch(
	() => user.value.sms_notifications_enabled,
	(value) => {
		smsEnabled.value = value;
	},
);

// Auto-check the SMS market-notification box when the user first enables the SMS channel
watch(smsEnabled, (enabled, wasEnabled) => {
	if (enabled && !wasEnabled && user.value.market_scheduled_asset_price_include_sms == null) {
		user.value = { ...user.value, market_scheduled_asset_price_include_sms: true };
	}
});

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
</script>
