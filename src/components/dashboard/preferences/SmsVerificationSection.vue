<template>
	<div v-if="smsEnabled" :id="phoneVerificationSectionId" class="ml-6 space-y-4">
		<div v-if="user.phone_verified" class="bg-green-50 border border-green-200 rounded-lg p-4">
			<p class="text-green-800 text-sm">
				<span aria-hidden="true">✓ </span>
				Phone verified: {{ user.phone_country_code }} {{ user.phone_number }}
			</p>
		</div>
		<fieldset v-else :id="phoneVerificationFieldsetId" class="space-y-4" :disabled="!smsEnabled">
			<legend class="sr-only">Phone Verification</legend>

			<SmsPhoneSetup
				v-if="isPhoneSetup"
				:user="user"
				:send-verification-disabled="sendVerificationDisabled"
				:send-verification-button-id="sendVerificationButtonId"
				@phone-validity-changed="handleValidityChanged"
			/>

			<SmsCodeVerification
				v-else-if="shouldShowVerification"
				:user="user"
				:success-message="successMessage"
				:sms-verification-code-id="smsVerificationCodeId"
				:form-submitted="formSubmitted"
				@otp-input="formSubmitted = false"
			/>
		</fieldset>
	</div>
</template>

<script lang="ts" setup>
import { computed, ref, watch } from "vue";

import type { User } from "../../../lib/db";
import { DASHBOARD_FORM_ID } from "../constants";
import SmsCodeVerification from "./SmsCodeVerification.vue";
import SmsPhoneSetup from "./SmsPhoneSetup.vue";

interface Props {
	user: User;
	smsEnabled: boolean;
	isEditingPhone: boolean;
	successMessage?: string | null;
	sendVerificationDisabled: boolean;
	isVerifyingCode?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
	successMessage: null,
	isVerifyingCode: false,
});

const emit =
	defineEmits<(event: "phone-validity-changed", value: boolean) => void>();

const phoneVerificationSectionId = `${DASHBOARD_FORM_ID}-phone-verification-section`;
const phoneVerificationFieldsetId = `${DASHBOARD_FORM_ID}-phone-verification-fieldset`;
const sendVerificationButtonId = `${DASHBOARD_FORM_ID}-send-verification-button`;
const smsVerificationCodeId = `${DASHBOARD_FORM_ID}-sms-verification-code`;

const formSubmitted = ref(false);

const isPhoneSetup = computed(() => {
	return (
		!props.user.phone_country_code ||
		!props.user.phone_number ||
		props.isEditingPhone
	);
});

const shouldShowVerification = computed(() => {
	return !props.user.phone_verified && !props.isEditingPhone;
});

function handleValidityChanged(isValid: boolean) {
	emit("phone-validity-changed", isValid);
}

watch(
	() => props.isVerifyingCode,
	(isVerifying) => {
		if (isVerifying) {
			formSubmitted.value = true;
		}
	},
);
</script>
