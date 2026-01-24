<template>
	<form
		ref="formElement"
		:id="formId"
		method="POST"
		action="/api/preferences"
		class="space-y-6"
		@input="handleFormInput"
		@change="handleFormChange"
		@submit="handleFormSubmitWrapper"
	>
		<p
			:id="statusId"
			class="text-sm"
			:class="[
				statusMessage ? '' : 'hidden',
				statusTone === 'error' ? 'text-red-700' : 'text-blue-700',
			]"
			role="status"
			aria-live="polite"
			:data-tone="statusTone"
		>
			{{ statusMessage }}
		</p>

		<TrackedStocksPanel
			:stockOptions="stockOptions"
			:initialSymbols="initialSymbols"
			:onFormChanged="notifyChange"
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
			:onFormChanged="notifyChange"
			:savedPreferences="savedPreferences"
			:is-verifying-code="isVerifyingCode"
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
			:onFormChanged="notifyChange"
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
import { computed, ref, toRefs, watch } from "vue";

import type { User } from "../../lib/db";
import type { TimezoneOption } from "../../lib/time/cache";
import type { StockOption } from "./stocks/StockInput.vue";
import { useAutoSavePreferences } from "./composables/useAutoSavePreferences";
import ScheduledNotificationsPanel from "./notifications/scheduled/ScheduledNotificationsPanel.vue";
import PreferencesPanel from "./preferences/PreferencesPanel.vue";
import PreviewPanel from "./PreviewPanel.vue";
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
const smsOptedOut = computed(() => user.value.sms_opted_out);
const phoneVerified = computed(() => user.value.phone_verified);

const formElement = ref<HTMLFormElement | null>(null);
const isVerifyingCode = ref(false);
const {
	handleFormChange,
	handleFormInput,
	handleFormSubmit,
	notifyChange,
	savedPreferences,
	statusMessage,
	statusTone,
} = useAutoSavePreferences({
	formRef: formElement,
});

function handleFormSubmitWrapper(event: SubmitEvent) {
	const submitter = event.submitter;
	if (
		submitter instanceof HTMLElement &&
		submitter.getAttribute("formaction") === "/api/auth/sms/verify-code"
	) {
		isVerifyingCode.value = true;
		setTimeout(() => {
			isVerifyingCode.value = false;
		}, 100);
	}
	handleFormSubmit(event);
}
</script>
