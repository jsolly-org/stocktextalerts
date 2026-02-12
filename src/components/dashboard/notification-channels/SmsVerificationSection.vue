<template>
	<Transition name="sms-verification-expand" @after-enter="onSectionAfterEnter">
		<section
			v-if="smsEnabled"
			:id="phoneVerificationSectionId"
			class="pb-3 space-y-3"
		>
			<p v-if="user.phone_verified && !isEditingPhone" class="flex items-center gap-1.5 text-sm text-gray-600">
				<CheckCircleIcon class="size-4 text-success-strong shrink-0" aria-hidden="true" />
				<span class="sr-only">Phone verified: </span>
				<span>{{ formattedVerifiedPhone }}</span>
				<span class="text-gray-400 mx-0.5" aria-hidden="true">·</span>
				<button
					type="button"
					class="link-action"
					@click="handleChangeNumberClick"
				>
					Change
				</button>
			</p>
			<fieldset v-else :id="phoneVerificationFieldsetId" class="space-y-3">
				<legend class="sr-only">Phone Verification</legend>

				<SmsPhoneSetup
					ref="phoneSetupRef"
					v-if="isPhoneSetup"
					:user="user"
					:send-verification-disabled="sendVerificationDisabled"
					:send-verification-button-id="sendVerificationButtonId"
					:is-sending-verification="isSendingVerification"
					@phone-validity-changed="handleValidityChanged"
				/>

				<SmsCodeVerification
					v-else-if="shouldShowVerification"
					:user="user"
					:success-message="smsSuccessMessage"
					:sms-verification-code-id="smsVerificationCodeId"
					:form-submitted="formSubmitted"
					:is-sending-verification="isSendingVerification"
					:is-verifying-code="isVerifyingCode"
					@otp-input="formSubmitted = false"
					@change-number="handleChangeNumberClick"
				/>
			</fieldset>
		</section>
	</Transition>
</template>

<script lang="ts" setup>
import { computed, nextTick, ref, watch } from "vue";
// ?component suffix required: Astro Icon cannot be used in Vue; vite-svg-loader compiles this to a Vue component.
import CheckCircleIcon from "../../../icons/check-circle-20.svg?component";
import { DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID } from "../../../lib/constants";
import { formatPhoneForDisplay } from "../../../lib/messaging/format-phone";
import { useDashboardUser } from "../composables/useDashboardUser";
import { useSmsVerificationContext } from "../composables/useSmsVerificationContext";
import SmsCodeVerification from "./SmsCodeVerification.vue";
import SmsPhoneSetup from "./SmsPhoneSetup.vue";

interface Props {
	smsEnabled: boolean;
}

const props = defineProps<Props>();

// Inject shared state instead of receiving drilled props
const user = useDashboardUser();
const {
	isEditingPhone,
	smsSuccessMessage,
	sendVerificationDisabled,
	isVerifyingCode,
	isSendingVerification,
} = useSmsVerificationContext();

const phoneVerificationSectionId = `${DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID}-phone-verification-section`;
const phoneVerificationFieldsetId = `${DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID}-phone-verification-fieldset`;
const sendVerificationButtonId = `${DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID}-send-verification-button`;
const smsVerificationCodeId = `${DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID}-sms-verification-code`;

const formSubmitted = ref(false);
const phoneSetupRef = ref<{ focus: () => void } | null>(null);

const isPhoneSetup = computed(() => {
	return (
		!user.value.phone_country_code ||
		!user.value.phone_number ||
		isEditingPhone.value
	);
});

const shouldShowVerification = computed(() => {
	return !user.value.phone_verified && !isEditingPhone.value;
});

const formattedVerifiedPhone = computed(() =>
	formatPhoneForDisplay(
		user.value.phone_country_code ?? "",
		user.value.phone_number ?? "",
	),
);

/** Receive phone input validity updates from `SmsPhoneSetup`. */
function handleValidityChanged(isValid: boolean) {
	sendVerificationDisabled.value = !isValid;
}

/**
 * Switch the UI into "change number" mode and persist a lightweight marker
 * so navigation back to the dashboard can restore pending state.
 */
function handleChangeNumberClick() {
	// Ensure pending SMS state is saved before navigation.
	try {
		const storageKey = `pending_sms_enabled:${user.value.id}`;
		const hasPending = props.smsEnabled && !user.value.phone_verified;
		if (hasPending) {
			sessionStorage.setItem(storageKey, "true");
		} else {
			sessionStorage.removeItem(storageKey);
		}
	} catch {
		// Silently fail - state should already be saved.
	}
	isEditingPhone.value = true;
}

/** After the expand transition, focus the phone setup input for faster completion. */
function onSectionAfterEnter() {
	if (isPhoneSetup.value) {
		phoneSetupRef.value?.focus();
	}
}

watch(
	() => isVerifyingCode.value,
	(isVerifying) => {
		if (isVerifying) {
			formSubmitted.value = true;
		}
	},
);

// Focus phone input when entering change phone mode (no transition; nextTick suffices)
watch(
	() => isEditingPhone.value,
	async (isEditing) => {
		if (isEditing && isPhoneSetup.value) {
			await nextTick();
			phoneSetupRef.value?.focus();
		}
	},
);
</script>

<style scoped>
.sms-verification-expand-enter-active,
.sms-verification-expand-leave-active {
	overflow: hidden;
	transition:
		max-height 180ms ease,
		opacity 180ms ease,
		transform 180ms ease;
}

.sms-verification-expand-enter-from,
.sms-verification-expand-leave-to {
	max-height: 0;
	opacity: 0;
	transform: translateY(-2px);
}

.sms-verification-expand-enter-to,
.sms-verification-expand-leave-from {
	/* Large enough to cover the tallest verification UI state. */
	max-height: min(640px, 80vh);
	opacity: 1;
	transform: translateY(0);
}

@media (prefers-reduced-motion: reduce) {
	.sms-verification-expand-enter-active,
	.sms-verification-expand-leave-active {
		transition: none;
	}
}
</style>
