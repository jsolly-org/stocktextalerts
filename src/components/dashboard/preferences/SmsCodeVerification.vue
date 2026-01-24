<template>
	<div class="space-y-4">
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
				@input="emitOtpInput"
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
	</div>
</template>

<script lang="ts" setup>
import type { User } from "../../../lib/db";
import { formatMessage } from "../../../lib/status-messages";
import OtpInput from "./OtpInput.vue";

interface Props {
	user: User;
	successMessage?: string | null;
	smsVerificationCodeId: string;
	formSubmitted: boolean;
}

const props = withDefaults(defineProps<Props>(), {
	successMessage: null,
});

const emit = defineEmits<{
	(event: "otp-input"): void;
}>();

function emitOtpInput() {
	emit("otp-input");
}
</script>
