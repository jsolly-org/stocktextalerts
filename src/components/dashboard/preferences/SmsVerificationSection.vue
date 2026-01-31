<template>
	<Transition name="sms-verification-expand" @after-enter="onSectionAfterEnter">
		<section
			v-if="smsEnabled"
			:id="phoneVerificationSectionId"
			class="pl-12 pr-4 pb-3 space-y-3"
		>
			<p v-if="user.phone_verified && !isEditingPhone" class="flex items-center gap-1.5 text-sm text-gray-600">
				<CheckCircleIcon class="size-4 text-success-strong shrink-0" aria-hidden="true" />
				<span class="sr-only">Phone verified: </span>
				<span>{{ formattedVerifiedPhone }}</span>
				<span class="text-gray-400 mx-0.5" aria-hidden="true">·</span>
				<button
					type="button"
					class="text-primary hover:underline rounded cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
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
					:success-message="successMessage"
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
import { DASHBOARD_FORM_ID } from "../../../lib/constants";
import type { User } from "../../../lib/db";
import { formatPhoneForDisplay } from "../../../lib/format-phone";
import SmsCodeVerification from "./SmsCodeVerification.vue";
import SmsPhoneSetup from "./SmsPhoneSetup.vue";

interface Props {
	user: User;
	smsEnabled: boolean;
	isEditingPhone: boolean;
	successMessage?: string | null;
	sendVerificationDisabled: boolean;
	isVerifyingCode?: boolean;
	isSendingVerification?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
	successMessage: null,
	isVerifyingCode: false,
	isSendingVerification: false,
});

const emit = defineEmits<{
	(event: "phone-validity-changed", value: boolean): void;
	(event: "phone-editing-changed", value: boolean): void;
}>();

const phoneVerificationSectionId = `${DASHBOARD_FORM_ID}-phone-verification-section`;
const phoneVerificationFieldsetId = `${DASHBOARD_FORM_ID}-phone-verification-fieldset`;
const sendVerificationButtonId = `${DASHBOARD_FORM_ID}-send-verification-button`;
const smsVerificationCodeId = `${DASHBOARD_FORM_ID}-sms-verification-code`;

const formSubmitted = ref(false);
const phoneSetupRef = ref<{ focus: () => void } | null>(null);

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

const formattedVerifiedPhone = computed(() =>
	formatPhoneForDisplay(
		props.user.phone_country_code ?? "",
		props.user.phone_number ?? "",
	),
);

function handleValidityChanged(isValid: boolean) {
	emit("phone-validity-changed", isValid);
}

function handleChangeNumberClick() {
	// Ensure pending SMS state is saved before navigation.
	// The state should already be saved via watch(hasPendingSmsChanges), but ensure it's persisted.
	try {
		const storageKey = `pending_sms_enabled:${props.user.id}`;
		const hasPending = props.smsEnabled && !props.user.phone_verified;
		if (hasPending) {
			sessionStorage.setItem(storageKey, "true");
		} else {
			// If SMS is disabled, remove any persisted pending flag so it can't be restored and
			// re-enable SMS unexpectedly.
			sessionStorage.removeItem(storageKey);
		}
	} catch (error) {
		// Silently fail - state should already be saved.
	}
	emit("phone-editing-changed", true);
}

function onSectionAfterEnter() {
	if (isPhoneSetup.value) {
		phoneSetupRef.value?.focus();
	}
}

watch(
	() => props.isVerifyingCode,
	(isVerifying) => {
		if (isVerifying) {
			formSubmitted.value = true;
		}
	},
);

// Focus phone input when entering change phone mode (no transition; nextTick suffices)
watch(
	() => props.isEditingPhone,
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
</style>
