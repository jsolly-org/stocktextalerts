<template>
	<div class="space-y-4">
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
	</div>
</template>

<script lang="ts" setup>
import type { User } from "../../../lib/db";
import PhoneInput from "./PhoneInput.vue";

interface Props {
	user: User;
	sendVerificationDisabled: boolean;
	sendVerificationButtonId: string;
}

defineProps<Props>();

const emit =
	defineEmits<(event: "phone-validity-changed", value: boolean) => void>();

function handleValidityChanged(isValid: boolean) {
	emit("phone-validity-changed", isValid);
}
</script>
