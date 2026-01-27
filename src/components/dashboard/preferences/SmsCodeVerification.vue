<template>
	<div class="space-y-4">
		<StatusMessage v-if="props.successMessage === 'verification_sent'" tone="success">
			<span aria-hidden="true">✓ </span>
			{{ formatMessage(props.successMessage) }}
		</StatusMessage>
		<div class="space-y-2">
			<p v-if="!isExpired" class="text-sm text-gray-700">
				We sent a verification code to your phone.
			</p>
			<div class="flex items-center gap-4">
				<button
					type="button"
					formaction="/api/auth/sms/send-verification"
					formmethod="post"
					formnovalidate
					:disabled="isSendingVerification || !canResend"
					:aria-busy="isSendingVerification"
					class="inline-flex items-center gap-2 px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary-strong transition-colors text-sm cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
					@click="handleResendClick"
				>
					<ArrowPathIcon
						v-if="isSendingVerification"
						class="animate-spin size-4 shrink-0"
						aria-hidden="true"
					/>
					<span>
						{{
							isSendingVerification
								? "Sending..."
								: !canResend
									? `Resend (${formattedResendTime})`
									: "Resend Verification Code"
						}}
					</span>
				</button>
				<div class="flex items-center gap-2">
					<span class="text-sm text-gray-700">
						{{ user.phone_country_code }} {{ user.phone_number }}
					</span>
					<a
						href="/dashboard?change_phone=1"
						class="text-sm text-primary hover:underline"
						@click.prevent="handleChangeNumberClick"
					>
						Change number
					</a>
				</div>
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
				@input="handleOtpInput"
			/>
			<p v-if="isVerifyingCode" class="text-sm text-gray-700 flex items-center gap-2">
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

function clearTimer() {
	if (!intervalId) return;
	clearInterval(intervalId);
	intervalId = null;
}

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

function emitOtpInput() {
	emit("otp-input");
}

function handleOtpInput(code: string) {
	otpCode.value = code;
	emitOtpInput();
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

function handleResendClick(event: MouseEvent) {
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

function handleChangeNumberClick() {
	// Ensure pending SMS state is saved before navigation
	// The state should already be saved via watch(hasPendingSmsChanges), but ensure it's persisted
	try {
		const storageKey = `pending_sms_enabled:${props.user.id}`;
		const hasPending = !props.user.phone_verified; // Simplified check - if phone not verified and SMS enabled, there's pending state
		if (hasPending) {
			sessionStorage.setItem(storageKey, "true");
		}
	} catch (error) {
		// Silently fail - state should already be saved
	}
	// Set flag to allow navigation without beforeunload warning
	const win = window as Window & { __allowChangePhoneNavigation?: boolean };
	win.__allowChangePhoneNavigation = true;
	try {
		// Update URL using pushState for client-side navigation (no page reload)
		const url = new URL(window.location.href);
		url.searchParams.set("change_phone", "1");
		window.history.pushState(window.history.state, document.title, url.toString());
		// Dispatch a custom event to notify DashboardPanels to update isEditingPhone state
		window.dispatchEvent(new CustomEvent("dashboard-url-changed"));
	} finally {
		// Always reset the flag, even if navigation throws
		win.__allowChangePhoneNavigation = false;
	}
}
</script>
