<template>
	<form
		ref="stocksFormElement"
		:id="DASHBOARD_STOCKS_FORM_ID"
		method="POST"
		action="/api/stocks/update"
		class="space-y-6"
		aria-label="Tracked stocks"
		:aria-busy="isStocksSaving"
		@input="handleStocksFormInput"
		@change="handleStocksFormChange"
		@submit="handleStocksFormSubmit"
	>
		<TrackedStocksPanel
			:stockOptions="stockOptions"
			:initialStocks="initialStocks"
			:status-message="stocksStatusMessage"
			:status-tone="stocksStatusTone"
			:is-saving="isStocksSaving"
			@form-changed="notifyStocksChange"
			@stocks-changed="currentStocks = $event"
		/>
	</form>

	<NotificationChannelsPanel
		v-model:emailEnabled="emailEnabled"
		v-model:smsEnabled="smsEnabled"
	/>

	<ScheduledNotificationsPanel
		:emailEnabled="emailEnabled"
		:smsEnabled="smsEnabled"
		:phoneVerified="phoneVerified"
	/>

	<AdditionalNotificationsPanel
		:emailEnabled="emailEnabled"
		:smsEnabled="smsEnabled"
		:phoneVerified="phoneVerified"
	/>

	<NotificationPreviewPanel
		:initialStocks="currentStocks"
		:emailEnabled="emailEnabled"
		:smsEnabled="smsEnabled"
		:phoneVerified="phoneVerified"
	/>
</template>

<script lang="ts" setup>
import { computed, ref, toRefs, watch } from "vue";
import { DASHBOARD_STOCKS_FORM_ID } from "../../lib/constants";
import type { User } from "../../lib/db";
import AdditionalNotificationsPanel from "./AdditionalNotificationsPanel.vue";
import { useAutoSaveForm } from "./composables/useAutoSaveNotificationPreferences";
import { provideDashboardUser } from "./composables/useDashboardUser";
import NotificationChannelsPanel from "./notification-channels/NotificationChannelsPanel.vue";
import NotificationPreviewPanel from "./notification-preview/NotificationPreviewPanel.vue";
import ScheduledNotificationsPanel from "./scheduled-notifications/ScheduledNotificationsPanel.vue";
import type { StockOption } from "./stocks/StockInput.vue";
import TrackedStocksPanel from "./stocks/TrackedStocksPanel.vue";
import type { InitialStock } from "./stocks/types";

interface Props {
	user: User;
	stockOptions: StockOption[];
	initialStocks: InitialStock[];
}

const props = defineProps<Props>();

const {
	initialStocks,
	stockOptions,
	user: userProp,
} = toRefs(props);

// Shared mutable user ref — all dashboard descendants inject this via useDashboardUser()
const user = provideDashboardUser(userProp);

// Live tracked stocks — starts from server data, updated by TrackedStocksPanel edits
const currentStocks = ref<InitialStock[]>([...props.initialStocks]);

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

// --- Stocks form (unchanged, future refactor candidate) ---
const stocksFormElement = ref<HTMLFormElement | null>(null);
const {
	handleFormChange: handleStocksFormChange,
	handleFormInput: handleStocksFormInput,
	handleFormSubmit: handleStocksFormSubmit,
	isSaving: isStocksSaving,
	notifyChange: notifyStocksChange,
	statusMessage: stocksStatusMessage,
	statusTone: stocksStatusTone,
} = useAutoSaveForm({
	formRef: stocksFormElement,
});
</script>
