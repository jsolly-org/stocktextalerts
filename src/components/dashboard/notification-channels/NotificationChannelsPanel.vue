<template>
	<form
		ref="notificationPreferencesFormElement"
		:id="DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID"
		method="POST"
		action="/api/notification-preferences/update"
		aria-label="Notification preferences"
		:aria-busy="isSaving"
		:data-hydrated="isHydrated || undefined"
		@input="handleFormInput"
		@change="handleFormChange"
		@submit="handleFormSubmit"
	>
		<section
			class="card relative"
			data-notification-channels-card
			:data-form-id="DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID"
		>
			<FormStatusBadge
				:status-message="statusMessage"
				:status-tone="statusTone"
				:is-saving="isSaving"
				:id="DASHBOARD_NOTIFICATION_PREFERENCES_STATUS_ID"
			/>

			<div class="card-body">
				<NotificationChannelsFieldset
					v-model:delivery-channel="deliveryChannelModel"
					:notification-channels-desc-id="notificationChannelsDescId"
				/>

				<SetupRequiredNotice
					:needs-tracked-assets="needsTrackedAssets"
					:needs-channel-selection="needsChannelSelection"
				/>

				<div
					v-if="previewChannel"
					class="mt-6 transition-opacity duration-200"
					:class="{ 'opacity-50': notificationSetupBlocked }"
				>
					<div class="flex min-w-0 justify-center">
						<NotificationPreview :assets="previewAssets" :channel="previewChannel" />
					</div>
				</div>
			</div>
		</section>
	</form>
</template>

<script lang="ts" setup>
import { computed, ref, watch } from "vue";
import type { DeliveryChannelMode } from "../../../lib/constants";
import { needsNotificationChannelSelection } from "../../../lib/messaging/delivery-channel";
import { useHydrated } from "../../useHydrated";
import { useAutoSaveForm } from "../composables/useAutoSaveNotificationPreferences";
import { useDashboardUser } from "../composables/useDashboardUser";
import {
	DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID,
	DASHBOARD_NOTIFICATION_PREFERENCES_STATUS_ID,
} from "../constants";
import FormStatusBadge from "../shared/FormStatusBadge.vue";
import SetupRequiredNotice from "../shared/SetupRequiredNotice.vue";
import type { InitialAsset, NotificationPreferencesData } from "../types";
import NotificationChannelsFieldset from "./NotificationChannelsFieldset.vue";
import NotificationPreview from "./preview/NotificationPreview.vue";
import { DEMO_ASSETS } from "./preview/preview-data";
import type { NotificationPreviewChannel, PreviewAsset } from "./preview/types";

interface Props {
	initialAssets: InitialAsset[];
	hasTrackedAssets: boolean;
}

const props = defineProps<Props>();

const user = useDashboardUser();

const isHydrated = useHydrated();

const notificationPreferencesFormElement = ref<HTMLFormElement | null>(null);
const {
	handleFormChange,
	handleFormInput,
	handleFormSubmit,
	isSaving,
	notifyChange,
	savedData: savedNotificationPreferencesData,
	statusMessage,
	statusTone,
} = useAutoSaveForm<NotificationPreferencesData>({
	formRef: notificationPreferencesFormElement,
});

const notificationChannelsDescId = `${DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID}-notification-channels-desc`;

const deliveryChannelModel = computed({
	get: () => user.value.delivery_channel,
	set: (value: DeliveryChannelMode) => {
		user.value = { ...user.value, delivery_channel: value };
		notifyChange();
	},
});

watch(
	() => savedNotificationPreferencesData.value,
	(newData) => {
		if (newData) {
			user.value = {
				...user.value,
				delivery_channel: newData.delivery_channel,
				daily_notification_time: newData.daily_notification_time,
				daily_notification_next_send_at: newData.daily_notification_next_send_at,
				market_scheduled_asset_price_next_send_at: newData.market_scheduled_asset_price_next_send_at,
			};
		}
	},
);

const needsTrackedAssets = computed(() => !props.hasTrackedAssets);
const needsChannelSelection = computed(() => needsNotificationChannelSelection(user.value));
const notificationSetupBlocked = computed(
	() => needsChannelSelection.value || needsTrackedAssets.value,
);
const previewChannel = computed((): NotificationPreviewChannel | null => {
	const channel = deliveryChannelModel.value;
	return channel === "email" || channel === "telegram" ? channel : null;
});

const previewAssets = computed<PreviewAsset[]>(() => {
	const assets = props.initialAssets;
	if (assets.length === 0) {
		return DEMO_ASSETS;
	}
	return assets.slice(0, 3).map((asset, i) => {
		const demo = DEMO_ASSETS[i % DEMO_ASSETS.length];
		return {
			symbol: asset.symbol,
			name: asset.name,
			price: demo.price,
			changePercent: demo.changePercent,
			sparkline: demo.sparkline,
			sparklineValues: demo.sparklineValues,
		};
	});
});
</script>
