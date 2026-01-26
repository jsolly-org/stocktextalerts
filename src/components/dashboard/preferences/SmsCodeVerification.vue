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
					:disabled="isSendingVerification || !canResend"
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
				<span v-if="!canResend" class="text-sm text-gray-600">
					Resend available in {{ formattedResendTime }}
				</span>
				<a href="/dashboard?change_phone=1" class="text-sm text-primary hover:underline">
					Change number
				</a>
			</div>
			<p v-if="verificationSentAt && !isExpired" class="text-sm text-gray-600">
				Code expires in {{ formattedExpirationTime }}.
			</p>
			<p v-else-if="verificationSentAt" class="text-sm text-gray-700">
				This code has expired. Request a new code to continue.
			</p>
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
import { computed, onUnmounted, ref } from "vue";
// ?component suffix required: Astro Icon cannot be used in Vue; vite-svg-loader compiles this to a Vue component.
import ArrowPathIcon from "../../../icons/arrow-path.svg?component";
import { formatMessage, 
	VERIFICATION_EXPIRATION_MS,
	VERIFICATION_RESEND_COOLDOWN_MS,} from "../../../lib/constants";
import type { User } from "../../../lib/db";
import StatusMessage from "../../StatusMessage.vue";
import OtpInput from "./OtpInput.vue";

interface Props {
	user: User;
	successMessage?: string | null;
	smsVerificationCodeId: string;
	formSubmitted: boolean;
	isSendingVerification?: boolean;
	isVerifyingCode?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
	successMessage: null,
	isSendingVerification: false,
	isVerifyingCode: false,
});

const emit = defineEmits<(event: "otp-input") => void>();

// verification_sent_at will be available after database types are regenerated
const verificationSentAt = (props.user as User & { verification_sent_at?: string | null })
	.verification_sent_at;
const now = ref(Date.now());
let intervalId: ReturnType<typeof setInterval> | null = null;

const startTime = verificationSentAt
	? new Date(verificationSentAt).getTime()
	: null;
const expirationTime = startTime ? startTime + VERIFICATION_EXPIRATION_MS : null;
const resendAvailableTime = startTime
	? startTime + VERIFICATION_RESEND_COOLDOWN_MS
	: null;

const expirationRemaining = computed(() => {
	if (!expirationTime) {
		return 0;
	}
	const remaining = expirationTime - now.value;
	return Math.max(0, remaining);
});

const resendRemaining = computed(() => {
	if (!resendAvailableTime) {
		return 0;
	}
	const remaining = resendAvailableTime - now.value;
	return Math.max(0, remaining);
});

const isExpired = computed(() => {
	return expirationRemaining.value === 0;
});

const canResend = computed(() => {
	return resendRemaining.value === 0;
});

const formatRemaining = (remaining: number) => {
	if (remaining === 0) {
		return "0:00";
	}
	const totalSeconds = Math.ceil(remaining / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

const formattedExpirationTime = computed(() => {
	return formatRemaining(expirationRemaining.value);
});

const formattedResendTime = computed(() => {
	return formatRemaining(resendRemaining.value);
});

if (
	verificationSentAt &&
	((expirationTime && expirationTime > Date.now()) ||
		(resendAvailableTime && resendAvailableTime > Date.now()))
) {
	intervalId = setInterval(() => {
		now.value = Date.now();
		if (isExpired.value && canResend.value && intervalId) {
			clearInterval(intervalId);
			intervalId = null;
		}
	}, 1000);
}

onUnmounted(() => {
	if (intervalId) {
		clearInterval(intervalId);
	}
});

function emitOtpInput() {
	emit("otp-input");
}
</script>
