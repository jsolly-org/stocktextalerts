<template>
	<form
		ref="preferencesFormElement"
		:id="DASHBOARD_FORM_ID"
		method="POST"
		action="/api/preferences/update"
		class="space-y-6"
		:aria-busy="isPreferencesSaving"
		@input="handlePreferencesFormInput"
		@change="handlePreferencesFormChange"
		@submit="handlePreferencesFormSubmitWrapper"
	>
		<p
			v-if="preferencesStatusMessage"
			:id="DASHBOARD_STATUS_ID"
			class="text-sm flex items-center gap-2"
			:class="[
				preferencesStatusTone === 'error' ? 'text-red-700' : 'text-blue-700',
			]"
			role="status"
			aria-live="polite"
			:aria-busy="isPreferencesSaving"
			:data-tone="preferencesStatusTone"
		>
			<Icon
				v-show="isPreferencesSaving"
				name="arrow-path"
				class="animate-spin size-4 shrink-0"
				aria-hidden="true"
			/>
			{{ preferencesStatusMessage }}
		</p>

		<PreferencesPanel
			:user="user"
			:timezones="timezones"
			:timezoneLoadError="timezoneLoadError"
			:isEditingPhone="isEditingPhone"
			:successMessage="successMessage"
			:emailEnabled="emailEnabled"
			:smsEnabled="smsEnabled"
			:onFormChanged="notifyPreferencesChange"
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
			:onFormChanged="notifyPreferencesChange"
			:savedPreferences="savedPreferences"
		/>
	</form>

	<form
		ref="stocksFormElement"
		:id="DASHBOARD_STOCKS_FORM_ID"
		method="POST"
		action="/api/stocks/update"
		class="space-y-6"
		:aria-busy="isStocksSaving"
		@input="handleStocksFormInput"
		@change="handleStocksFormChange"
		@submit="handleStocksFormSubmit"
	>
		<p
			v-if="stocksStatusMessage"
			:id="DASHBOARD_STOCKS_STATUS_ID"
			class="text-sm flex items-center gap-2"
			:class="[
				stocksStatusTone === 'error' ? 'text-red-700' : 'text-blue-700',
			]"
			role="status"
			aria-live="polite"
			:aria-busy="isStocksSaving"
			:data-tone="stocksStatusTone"
		>
			<Icon
				v-show="isStocksSaving"
				name="arrow-path"
				class="animate-spin size-4 shrink-0"
				aria-hidden="true"
			/>
			{{ stocksStatusMessage }}
		</p>

		<TrackedStocksPanel
			:stockOptions="stockOptions"
			:initialSymbols="initialSymbols"
			:onFormChanged="notifyStocksChange"
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
import { Icon } from "astro-icon/components";
import { computed, ref, toRefs, watch } from "vue";

import type { User } from "../../lib/db";
import type { TimezoneOption } from "../../lib/time/cache";
import {
	type PreferencesData,
	useAutoSaveForm,
} from "./composables/useAutoSavePreferences";
import {
	DASHBOARD_FORM_ID,
	DASHBOARD_STATUS_ID,
	DASHBOARD_STOCKS_FORM_ID,
	DASHBOARD_STOCKS_STATUS_ID,
} from "./constants";
import ScheduledNotificationsPanel from "./notifications/scheduled/ScheduledNotificationsPanel.vue";
import PreviewPanel from "./PreviewPanel.vue";
import PreferencesPanel from "./preferences/PreferencesPanel.vue";
import type { StockOption } from "./stocks/StockInput.vue";
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

const preferencesFormElement = ref<HTMLFormElement | null>(null);
const stocksFormElement = ref<HTMLFormElement | null>(null);
const isVerifyingCode = ref(false);
const {
	handleFormChange: handlePreferencesFormChange,
	handleFormInput: handlePreferencesFormInput,
	handleFormSubmit: handlePreferencesFormSubmit,
	isSaving: isPreferencesSaving,
	notifyChange: notifyPreferencesChange,
	savedData: savedPreferencesData,
	statusMessage: preferencesStatusMessage,
	statusTone: preferencesStatusTone,
} = useAutoSaveForm<PreferencesData>({
	formRef: preferencesFormElement,
});

const savedPreferences = savedPreferencesData;

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

async function handlePreferencesFormSubmitWrapper(event: SubmitEvent) {
	const submitter = event.submitter;
	const isVerifyCodeSubmission =
		submitter instanceof HTMLElement &&
		submitter.getAttribute("formaction") === "/api/auth/sms/verify-code";

	if (isVerifyCodeSubmission) {
		isVerifyingCode.value = true;
	}
	try {
		await handlePreferencesFormSubmit(event);
	} finally {
		if (isVerifyCodeSubmission) {
			isVerifyingCode.value = false;
		}
	}
}
</script>
