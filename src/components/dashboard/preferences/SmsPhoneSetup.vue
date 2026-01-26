<template>
	<div class="space-y-4">
		<PhoneInput
			ref="phoneInputRef"
			required
			:initial-national-number="user.phone_number"
			@validity-changed="handleValidityChanged"
		/>
		<button
			type="submit"
			formaction="/api/auth/sms/send-verification"
			formmethod="post"
			:id="sendVerificationButtonId"
		:disabled="sendVerificationDisabled || isSendingVerification"
		:aria-busy="isSendingVerification"
		class="inline-flex items-center gap-2 px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary-strong transition-colors text-sm mt-4 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
		>
		<ArrowPathIcon
			v-if="isSendingVerification"
			class="animate-spin size-4 shrink-0"
			aria-hidden="true"
		/>
		<span>{{ isSendingVerification ? "Sending..." : "Send Verification Code" }}</span>
		</button>
	</div>
</template>

<script lang="ts" setup>
import { onMounted, ref } from "vue";
// ?component suffix required: Astro Icon cannot be used in Vue; vite-svg-loader compiles this to a Vue component.
import ArrowPathIcon from "../../../icons/arrow-path.svg?component";
import type { User } from "../../../lib/db";
import PhoneInput from "./PhoneInput.vue";

interface Props {
	user: User;
	sendVerificationDisabled: boolean;
	sendVerificationButtonId: string;
	isSendingVerification: boolean;
}

const props = defineProps<Props>();

const emit =
	defineEmits<(event: "phone-validity-changed", value: boolean) => void>();

const phoneInputRef = ref<{ focus: () => void } | null>(null);

function handleValidityChanged(isValid: boolean) {
	emit("phone-validity-changed", isValid);
}

// Focus the phone input when component mounts (e.g., when entering change phone mode)
onMounted(() => {
	// Use nextTick to ensure the input is rendered after the transition
	setTimeout(() => {
		phoneInputRef.value?.focus();
	}, 200);
});

// Expose focus method for parent components
defineExpose({
	focus: () => {
		phoneInputRef.value?.focus();
	},
});
</script>
