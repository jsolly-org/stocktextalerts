<template>
	<div
		v-if="needsSetup"
		class="mt-4 rounded-lg border border-warning-border bg-warning-bg p-4"
	>
		<p class="text-sm font-medium text-warning-text">Setup required</p>
		<ul class="mt-2 space-y-1 text-sm text-warning-text">
			<li v-if="needsChannelSelection">
				Enable at least one notification channel in
				<a
					:href="DASHBOARD_SECTION_HASHES.preferences"
					class="font-medium text-warning-text underline"
				>
					notification preferences
				</a>
				.
			</li>
			<li v-if="needsPhoneVerification">
				Verify your phone number in
				<a
					:href="`#${phoneVerificationSectionId}`"
					class="font-medium text-warning-text underline"
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
import { DASHBOARD_SECTION_HASHES } from "../../../../lib/dashboard/sections";

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
