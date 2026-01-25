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
			<Icon
				v-show="isSaving"
				name="arrow-path"
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
import { Icon } from "astro-icon/components";

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

watch(
	() => user.value.email_notifications_enabled,
	(newValue) => {
		emailEnabled.value = newValue;
	},
);

watch(
	() => user.value.sms_notifications_enabled,
	(newValue) => {
		smsEnabled.value = newValue;
	},
);

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
	try {
		await handleFormSubmit(event);
	} finally {
		if (isVerifyCodeSubmission) {
			isVerifyingCode.value = false;
		}
	}
}
</script>
