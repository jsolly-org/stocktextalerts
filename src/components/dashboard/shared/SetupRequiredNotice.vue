<template>
	<div
		v-if="needsSetup"
		class="mt-4 rounded-lg border border-warning-border bg-warning-bg p-4"
		role="status"
		aria-live="polite"
	>
		<p class="flex items-center gap-2 text-sm font-medium text-warning-text">
			<ExclamationTriangleIcon class="size-5 shrink-0" aria-hidden="true" />
			Setup required
		</p>
		<ul class="mt-2 space-y-1.5 text-sm text-warning-text list-disc list-inside ml-0.5">
			<li v-if="needsTrackedAssets">
				{{ trackedAssetsMessage ?? "Add at least one tracked asset" }} in
				<a
					:href="DASHBOARD_SECTION_HASHES.assets"
					class="font-medium text-warning-text underline rounded-sm hover:text-warning-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning-strong focus-visible:ring-offset-1 focus-visible:ring-offset-warning-bg"
				>
					watchlist</a>.
			</li>
			<li v-if="needsChannelSelection">
				Enable at least one notification channel in
				<a
					:href="DASHBOARD_SECTION_HASHES.notificationChannels"
					class="font-medium text-warning-text underline rounded-sm hover:text-warning-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning-strong focus-visible:ring-offset-1 focus-visible:ring-offset-warning-bg"
				>
					notification channels</a>.
			</li>
		</ul>
	</div>
</template>

<script lang="ts" setup>
import { computed } from "vue";
// ?component suffix required: Astro Icon cannot be used in Vue; vite-svg-loader compiles this to a Vue component.
import ExclamationTriangleIcon from "../../../icons/exclamation-triangle-24.svg?component";
import { DASHBOARD_SECTION_HASHES } from "../../../lib/constants";

interface Props {
	needsTrackedAssets?: boolean;
	trackedAssetsMessage?: string;
	needsChannelSelection: boolean;
}

const props = defineProps<Props>();

const needsSetup = computed(
	() => Boolean(props.needsTrackedAssets) || props.needsChannelSelection,
);
</script>
