<template>
	<form
		ref="formElement"
		:id="DASHBOARD_FORM_ID"
		method="POST"
		action="/api/preferences"
		class="space-y-6"
		:aria-busy="isSaving"
		@input="handleFormInput"
		@change="handleFormChange"
		@submit="handleFormSubmitWrapper"
	>
		<p
			v-if="statusMessage"
			:id="DASHBOARD_STATUS_ID"
			class="text-sm flex items-center gap-2"
			:class="[statusTone === 'error' ? 'text-red-700' : 'text-blue-700']"
			role="status"
			aria-live="polite"
			:aria-busy="isSaving"
			:data-tone="statusTone"
		>
			<svg
				v-show="isSaving"
				xmlns="http://www.w3.org/2000/svg"
				fill="none"
				viewBox="0 0 24 24"
				stroke-width="1.5"
				stroke="currentColor"
				class="animate-spin size-4 shrink-0"
				aria-hidden="true"
			>
				<path
					stroke-linecap="round"
					stroke-linejoin="round"
					d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99"
				/>
			</svg>
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
			:emailEnabled="emailEnabled"
			:smsEnabled="smsEnabled"
			:smsOptedOut="smsOptedOut"
			:phoneVerified="phoneVerified"
			:onFormChanged="notifyChange"
			:savedPreferences="savedPreferences"
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
import { DASHBOARD_FORM_ID, DASHBOARD_STATUS_ID } from "./constants";
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
	timezoneLoadError?: boolean;
	successMessage?: string | null;
}

const props = withDefaults(defineProps<Props>(), {
	timezoneLoadError: false,
	successMessage: null,
});

const {
	initialSymbols,
	isEditingPhone,
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
	isSaving,
	notifyChange,
	savedPreferences,
	statusMessage,
	statusTone,
} = useAutoSavePreferences({
	formRef: formElement,
});

async function handleFormSubmitWrapper(event: SubmitEvent) {
	const submitter = event.submitter;
	const isVerifyCodeSubmission =
		submitter instanceof HTMLElement &&
		submitter.getAttribute("formaction") === "/api/auth/sms/verify-code";

	if (isVerifyCodeSubmission) {
		isVerifyingCode.value = true;
	}

	await handleFormSubmit(event);

	if (isVerifyCodeSubmission) {
		isVerifyingCode.value = false;
	}
}
</script>
