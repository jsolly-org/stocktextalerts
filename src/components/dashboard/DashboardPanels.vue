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
			:onFormChanged="notifyStocksChange"
			:status-message="stocksStatusMessage"
			:status-tone="stocksStatusTone"
			:is-saving="isStocksSaving"
		/>
	</form>

	<NotificationChannelsPanel
		v-model:emailEnabled="emailEnabled"
		v-model:smsEnabled="smsEnabled"
		:user="user"
		@user-updated="handleUserUpdated"
	/>

	<ScheduledNotificationsPanel
		:user="user"
		:emailEnabled="emailEnabled"
		:smsEnabled="smsEnabled"
		:phoneVerified="phoneVerified"
		@user-updated="handleUserUpdated"
	/>

	<NotificationPreviewPanel
		:user="user"
		:initialStocks="initialStocks"
	/>
</template>

<script lang="ts" setup>
import { computed, ref, toRefs, watch } from "vue";
import { DASHBOARD_STOCKS_FORM_ID } from "../../lib/constants";
import type { User } from "../../lib/db";
import { useAutoSaveForm } from "./composables/useAutoSaveNotificationPreferences";
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

// Local reactive copy of user that can be updated by child components
const user = ref<User>({ ...userProp.value });

// Sync with prop changes (e.g., after page reload)
watch(userProp, (newUser) => {
	user.value = { ...newUser };
}, { deep: true });

const emailEnabled = ref(user.value.email_notifications_enabled);
const smsEnabled = ref(user.value.sms_notifications_enabled);
const phoneVerified = computed(() => user.value.phone_verified);

function handleUserUpdated(updates: Partial<User>) {
	user.value = { ...user.value, ...updates };
}

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
