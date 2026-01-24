<template>
	<form
		ref="formElement"
		:id="formId"
		method="POST"
		action="/api/preferences"
		class="space-y-6"
		:aria-busy="isSaving"
		@input="handleFormInput"
		@change="handleFormChange"
		@submit="handleFormSubmitWrapper"
	>
		<p
			:id="statusId"
			class="text-sm flex items-center gap-2"
			:class="[
				statusMessage ? '' : 'hidden',
				statusTone === 'error' ? 'text-red-700' : 'text-blue-700',
			]"
			role="status"
			aria-live="polite"
			:aria-busy="isSaving"
			:data-tone="statusTone"
		>
			<ArrowPathIcon
				v-show="isSaving"
				class="animate-spin size-4 shrink-0"
				aria-hidden="true"
			/>
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
import { ArrowPathIcon } from "@heroicons/vue/24/outline";
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
