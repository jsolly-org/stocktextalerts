<template>
	<div
		v-if="needsSetup"
		class="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4"
	>
		<p class="text-sm font-medium text-amber-900">Setup required</p>
		<ul class="mt-2 space-y-1 text-sm text-amber-800">
			<li v-if="needsChannelSelection">
				Enable at least one notification channel in
				<a
					href="#notification-preferences"
					class="font-medium text-amber-900 underline"
				>
					notification preferences
				</a>
				.
			</li>
			<li v-if="needsPhoneVerification">
				Verify your phone number in
				<a
					:href="`#${phoneVerificationSectionId}`"
					class="font-medium text-amber-900 underline"
				>
					SMS settings
				</a>
				to enable SMS deliveries.
			</li>
		</ul>
	</div>
</template>

<script lang="ts" setup>
import { computed } from "vue";

interface Props {
	needsChannelSelection: boolean;
	needsPhoneVerification: boolean;
	phoneVerificationSectionId: string;
}

const props = defineProps<Props>();

const needsSetup = computed(
	() => props.needsChannelSelection || props.needsPhoneVerification,
);
</script>
