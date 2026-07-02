<template>
	<div class="space-y-4">
		<StatusMessage v-if="props.successMessage === 'verification_sent' && !isExpired" tone="success">
			<span aria-hidden="true">✓ </span>
			{{ formatMessage(props.successMessage) }}
		</StatusMessage>
		<div class="space-y-2">
			<p v-if="!isExpired" class="text-sm text-label">
				We sent a verification code to your phone.
			</p>
			<div class="flex flex-col gap-3 sm:flex-row sm:items-center">
				<button
					type="submit"
					formaction="/api/auth/sms/send-verification"
					formmethod="post"
					formnovalidate
					:disabled="isSendingVerification || !canResend"
					:aria-busy="isSendingVerification"
					class="btn btn-sm btn-primary self-start gap-2"
					@click="handleResendClick"
				>
					<ArrowPathIcon
						v-if="isSendingVerification"
						class="animate-spin size-4 shrink-0"
						aria-hidden="true"
					/>
					<span aria-live="polite">
						{{
							isSendingVerification
								? "Sending\u2026"
								: !canResend
									? `Resend (${formatRemaining(resendRemaining)})`
									: "Resend Verification Code"
						}}
					</span>
				</button>
				<div class="flex items-center gap-2">
					<span class="text-sm text-label">
						{{ formattedPhone }}
					</span>
					<a
						href="/dashboard#notification-channels"
						class="link-action text-sm"
						@click.prevent="emit('change-number')"
					>
						Change number
					</a>
				</div>
			</div>
			<p v-if="verificationSentAt && !isExpired" class="text-sm text-body-secondary">
				Code expires in {{ formatRemaining(expirationRemaining) }}.
			</p>
			<StatusMessage v-else-if="verificationSentAt" tone="warning">
				This code has expired. Request a new code to continue.
			</StatusMessage>
		</div>

		<input type="hidden" name="phone_country_code" :value="user.phone_country_code" />
		<input type="hidden" name="phone_number" :value="user.phone_number" />

		<div v-if="!isExpired" class="space-y-4 mt-4">
			<OtpInput
				:id="smsVerificationCodeId"
				name="code"
				required
				:form-submitted="formSubmitted"
				@input="handleOtpInput"
			/>
			<p v-if="isVerifyingCode" class="text-sm text-label flex items-center gap-2">
				<ArrowPathIcon class="animate-spin size-4 shrink-0" aria-hidden="true" />
				<span>Verifying…</span>
			</p>

			<!-- Hidden submit button so we can programmatically submit with a submitter (for DashboardPanels interception). -->
			<button
				ref="verifySubmitRef"
				type="submit"
				formaction="/api/auth/sms/verify-code"
				formmethod="post"
				class="sr-only"
				tabindex="-1"
				aria-hidden="true"
			>
				Verify Code
			</button>
		</div>
	</div>
</template>

<script lang="ts" setup>
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
// ?component suffix required: Astro Icon cannot be used in Vue; vite-svg-loader compiles this to a Vue component.
import ArrowPathIcon from "../../../icons/arrow-path.svg?component";
import {
	VERIFICATION_EXPIRATION_MS,
	VERIFICATION_RESEND_COOLDOWN_MS,
} from "../../../lib/constants";
import type { User } from "../../../lib/db/types";
import { formatPhoneForDisplay } from "../../../lib/messaging/format-phone";
import { formatMessage } from "../../../lib/messaging/status-messages";
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

const emit = defineEmits<{
	(event: "otp-input"): void;
	(event: "change-number"): void;
}>();

const verifySubmitRef = ref<HTMLButtonElement | null>(null);
const otpCode = ref("");
const lastAutoSubmittedCode = ref<string | null>(null);

const now = ref(Date.now());
let intervalId: ReturnType<typeof setInterval> | null = null;

// verification_sent_at may not be present in generated types yet, but it *is* in the DB.
const verificationSentAt = computed(() => {
	const value = (props.user as User & { verification_sent_at?: string | null })
		.verification_sent_at;
	return value ?? null;
});

const startTime = computed(() => {
	const sentAt = verificationSentAt.value;
	return sentAt ? new Date(sentAt).getTime() : null;
});
const expirationTime = computed(() => {
	const start = startTime.value;
	return start ? start + VERIFICATION_EXPIRATION_MS : null;
});
const resendAvailableTime = computed(() => {
	const start = startTime.value;
	return start ? start + VERIFICATION_RESEND_COOLDOWN_MS : null;
});

const expirationRemaining = computed(() => {
	if (!expirationTime.value) {
		return 0;
	}
	const remaining = expirationTime.value - now.value;
	return Math.max(0, remaining);
});

const resendRemaining = computed(() => {
	if (!resendAvailableTime.value) {
		return 0;
	}
	const remaining = resendAvailableTime.value - now.value;
	return Math.max(0, remaining);
});

const isExpired = computed(() => {
	return expirationRemaining.value === 0;
});

const canResend = computed(() => {
	return resendRemaining.value === 0;
});

const formattedPhone = computed(() =>
	formatPhoneForDisplay(
		props.user.phone_country_code ?? "",
		props.user.phone_number ?? "",
	),
);

/** Format a millisecond countdown as `M:SS`. */
function formatRemaining(remaining: number) {
	if (remaining === 0) {
		return "0:00";
	}
	const totalSeconds = Math.ceil(remaining / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/** Clear the ticking interval that drives countdown UI. */
function clearTimer() {
	if (!intervalId) return;
	clearInterval(intervalId);
	intervalId = null;
}

/**
 * Ensure a countdown timer is running while either expiration or resend cooldown is active.
 *
 * Stops automatically once the code is expired and the user can resend.
 */
function ensureTimer() {
	clearTimer();
	now.value = Date.now();

	if (!verificationSentAt.value) {
		return;
	}

	const expiresAt = expirationTime.value;
	const resendAt = resendAvailableTime.value;
	const shouldTick =
		(expiresAt && expiresAt > Date.now()) || (resendAt && resendAt > Date.now());

	if (!shouldTick) {
		return;
	}

	intervalId = setInterval(() => {
		now.value = Date.now();
		if (isExpired.value && canResend.value) {
			clearTimer();
		}
	}, 1000);
}

watch(
	verificationSentAt,
	() => {
		ensureTimer();
	},
	{ immediate: true },
);

onUnmounted(() => {
	clearTimer();
});

/** Receive OTP input events and store the current code. */
function handleOtpInput(code: string) {
	otpCode.value = code;
	emit("otp-input");
}

watch(
	() => [otpCode.value, props.isVerifyingCode] as const,
	async ([code, isVerifying]) => {
		if (isVerifying) {
			return;
		}
		if (code.length !== 6) {
			lastAutoSubmittedCode.value = null;
			return;
		}
		if (lastAutoSubmittedCode.value === code) {
			return;
		}
		const button = verifySubmitRef.value;
		const form = button?.form;
		if (!button || !form) {
			return;
		}

		lastAutoSubmittedCode.value = code;

		// Vue may not have flushed the hidden input's :value binding yet. Wait one tick
		// so the submitted FormData includes the OTP (Safari autofill is especially prone
		// to this timing issue with multi-input OTP UIs).
		await nextTick();

		const domCodeInput = form.querySelector('input[name="code"]');
		if (domCodeInput instanceof HTMLInputElement && domCodeInput.value !== code) {
			domCodeInput.value = code;
		}

		form.requestSubmit(button);
	},
);

/**
 * Intercept the resend click and submit the parent form using this button as the submitter.
 *
 * This preserves the `formaction`/`formmethod` on the button.
 */
function handleResendClick(event: MouseEvent) {
	event.preventDefault();
	const button = event.currentTarget;
	if (!(button instanceof HTMLButtonElement)) {
		return;
	}
	const form = button.form;
	if (!form) {
		return;
	}
	form.requestSubmit(button);
}
</script>
