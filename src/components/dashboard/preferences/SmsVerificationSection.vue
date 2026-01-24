<template>
	<div
		v-if="!user.sms_opted_out"
		:id="phoneVerificationSectionId"
		:class="['ml-6 space-y-4', { hidden: !smsEnabled }]"
	>
		<div v-if="user.phone_verified" class="bg-green-50 border border-green-200 rounded-lg p-4">
			<p class="text-green-800 text-sm">
				<span aria-hidden="true">✓ </span>
				Phone verified: {{ user.phone_country_code }} {{ user.phone_number }}
			</p>
		</div>
		<fieldset v-else :id="phoneVerificationFieldsetId" class="space-y-4" :disabled="!smsEnabled">
			<legend class="sr-only">Phone Verification</legend>

			<template v-if="!user.phone_country_code || !user.phone_number || isEditingPhone">
				<PhoneInput
					required
					:initial-national-number="user.phone_number"
					@validity-changed="handleValidityChanged"
				/>
				<button
					type="submit"
					formaction="/api/auth/sms/send-verification"
					formmethod="post"
					:id="sendVerificationButtonId"
					:disabled="sendVerificationDisabled"
					class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm mt-4 cursor-pointer disabled:bg-gray-400 disabled:cursor-not-allowed"
				>
					Send Verification Code
				</button>
			</template>

			<template v-else-if="!user.phone_verified && !isEditingPhone">
				<div
					v-if="successMessage === 'verification_sent'"
					class="bg-green-50 border border-green-200 rounded-lg p-4"
					role="alert"
				>
					<p class="text-green-800 text-sm">
						<span aria-hidden="true">✓ </span>
						{{ formatMessage(successMessage) }}
					</p>
				</div>
				<div class="space-y-2">
					<p class="text-sm text-slate-700">
						We sent a code to
						<span class="font-medium">
							{{ user.phone_country_code }} {{ user.phone_number }}
						</span>
						.
					</p>
					<div class="flex items-center gap-4">
						<button
							type="submit"
							formaction="/api/auth/sms/send-verification"
							formmethod="post"
							class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm cursor-pointer"
						>
							Resend Verification Code
						</button>
						<a href="/dashboard?change_phone=1" class="text-sm text-blue-600 hover:underline">
							Change number
						</a>
					</div>
				</div>

				<input type="hidden" name="phone_country_code" :value="user.phone_country_code" />
				<input type="hidden" name="phone_national_number" :value="user.phone_number" />

			<div class="space-y-4 mt-4">
				<OtpInput
					:id="smsVerificationCodeId"
					name="code"
					required
					:formSubmitted="formSubmitted"
					@input="formSubmitted = false"
				/>
				<button
					type="submit"
					formaction="/api/auth/sms/verify-code"
					formmethod="post"
					class="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors text-sm mt-4 cursor-pointer"
				>
					Verify Code
				</button>
			</div>
			</template>
		</fieldset>
	</div>
</template>

<script lang="ts" setup>
import { ref, watch } from "vue";
import type { User } from "../../../lib/db";
import { formatMessage } from "../../../lib/status-messages";
import OtpInput from "./OtpInput.vue";
import PhoneInput from "./PhoneInput.vue";

interface Props {
	user: User;
	smsEnabled: boolean;
	isEditingPhone: boolean;
	successMessage?: string | null;
	sendVerificationDisabled: boolean;
	phoneVerificationSectionId: string;
	phoneVerificationFieldsetId: string;
	sendVerificationButtonId: string;
	smsVerificationCodeId: string;
	isVerifyingCode?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
	successMessage: null,
	isVerifyingCode: false,
});

const emit = defineEmits<{
	(event: "phone-validity-changed", value: boolean): void;
}>();

const formSubmitted = ref(false);

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
