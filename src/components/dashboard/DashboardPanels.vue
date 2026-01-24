<template>
	<form
		:id="formId"
		method="POST"
		action="/api/preferences"
		class="space-y-6"
	>
		<p
			:id="statusId"
			class="text-sm text-red-700 hidden"
			role="status"
			aria-live="polite"
		></p>

		<TrackedStocksPanel
		:stockOptions="stockOptions"
			:initialSymbols="initialSymbols"
		/>

		<PreferencesPanel
			:user="user"
			:timezones="timezones"
			:timezoneLoadError="timezoneLoadError"
			:isEditingPhone="isEditingPhone"
			:formId="formId"
			:successMessage="successMessage"
			:emailEnabled="emailEnabled"
			:smsEnabled="smsEnabled"
			@update:emailEnabled="emailEnabled = $event"
			@update:smsEnabled="smsEnabled = $event"
		/>

		<ScheduledNotificationsPanel
			:user="user"
			:formId="formId"
			:emailEnabled="emailEnabled"
			:smsEnabled="smsEnabled"
			:smsOptedOut="smsOptedOut"
			:phoneVerified="phoneVerified"
		/>
	</form>

	<PreviewPanel
		:emailEnabled="emailEnabled"
		:smsEnabled="smsEnabled"
		:smsOptedOut="smsOptedOut"
		:phoneVerified="phoneVerified"
	/>
</template>

<script lang="ts" setup>
import { ref, toRefs } from "vue";

import type { User } from "../../lib/db";
import type { TimezoneOption } from "../../lib/time/cache";
import type { StockOption } from "./stocks/StockInput.vue";
import ScheduledNotificationsPanel from "./notifications/scheduled/ScheduledNotificationsPanel.vue";
import PreferencesPanel from "./preferences/PreferencesPanel.vue";
import PreviewPanel from "./preview/PreviewPanel.vue";
import TrackedStocksPanel from "./stocks/TrackedStocksPanel.vue";

interface Props {
	user: User;
	timezones: TimezoneOption[];
	stockOptions: StockOption[];
	initialSymbols: string[];
	isEditingPhone: boolean;
	formId: string;
	statusId: string;
	timezoneLoadError?: boolean;
	successMessage?: string | null;
}

const props = withDefaults(defineProps<Props>(), {
	timezoneLoadError: false,
	successMessage: null,
});

const {
	formId,
	initialSymbols,
	isEditingPhone,
	statusId,
	stockOptions,
	successMessage,
	timezones,
	timezoneLoadError,
	user,
} = toRefs(props);

const emailEnabled = ref(user.value.email_notifications_enabled);
const smsEnabled = ref(user.value.sms_notifications_enabled);
const smsOptedOut = ref(user.value.sms_opted_out);
const phoneVerified = ref(user.value.phone_verified);
</script>
