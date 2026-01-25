<template>
	<div class="space-y-4">
		<StatusMessage v-if="props.successMessage === 'verification_sent'" tone="success">
			<span aria-hidden="true">✓ </span>
			{{ formatMessage(props.successMessage) }}
		</StatusMessage>
		<div class="space-y-2">
			<p class="text-sm text-gray-700">
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
					:disabled="isSendingVerification"
					:aria-busy="isSendingVerification"
					class="inline-flex items-center gap-2 px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary-strong transition-colors text-sm cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
				>
					<ArrowPathIcon
						v-if="isSendingVerification"
						class="animate-spin size-4 shrink-0"
						aria-hidden="true"
					/>
					<span>{{ isSendingVerification ? "Sending..." : "Resend Verification Code" }}</span>
				</button>
				<a href="/dashboard?change_phone=1" class="text-sm text-primary hover:underline">
					Change number
				</a>
			</div>
		</div>

		<input type="hidden" name="phone_country_code" :value="user.phone_country_code" />
		<input type="hidden" name="phone_number" :value="user.phone_number" />

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
			:disabled="isVerifyingCode"
			:aria-busy="isVerifyingCode"
			class="inline-flex items-center gap-2 px-4 py-2 bg-success-strong text-white rounded-lg hover:bg-success-strong-hover transition-colors text-sm mt-4 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
			>
			<ArrowPathIcon
				v-if="isVerifyingCode"
				class="animate-spin size-4 shrink-0"
				aria-hidden="true"
			/>
			<span>{{ isVerifyingCode ? "Verifying..." : "Verify Code" }}</span>
			</button>
		</div>
	</div>
</template>

<script lang="ts" setup>
// ?component suffix required: Astro Icon cannot be used in Vue; vite-svg-loader compiles this to a Vue component.
import ArrowPathIcon from "../../../icons/arrow-path.svg?component";
import type { User } from "../../../lib/db";
import { formatMessage } from "../../../lib/status-messages";
import StatusMessage from "../../StatusMessage.vue";
import OtpInput from "./OtpInput.vue";

interface Props {
	user: User;
	successMessage?: string | null;
	smsVerificationCodeId: string;
	formSubmitted: boolean;
	isSendingVerification: boolean;
	isVerifyingCode: boolean;
}

const props = withDefaults(defineProps<Props>(), {
	successMessage: null,
	isSendingVerification: false,
	isVerifyingCode: false,
});

const emit = defineEmits<(event: "otp-input") => void>();

function emitOtpInput() {
	emit("otp-input");
}
</script>
