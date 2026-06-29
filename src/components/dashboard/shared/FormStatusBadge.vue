<template>
	<FadeTransition>
		<div
			v-if="statusMessage && (!showOnlyForTone || statusTone === showOnlyForTone)"
			:id="id"
			class="absolute top-3 right-3 flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium z-10 border"
			:class="STATUS_TONE_CLASSES[statusTone]"
			role="status"
			aria-live="polite"
			:aria-busy="isSaving"
			:data-tone="statusTone"
		>
			<ArrowPathIcon
				v-show="isSaving"
				class="animate-spin size-3 shrink-0"
				aria-hidden="true"
			/>
			{{ statusMessage }}
		</div>
	</FadeTransition>
</template>

<script lang="ts" setup>
import ArrowPathIcon from "../../../icons/arrow-path.svg?component";
import FadeTransition from "../../FadeTransition.vue";
import { STATUS_TONE_CLASSES, type StatusTone } from "../../ui-constants";

defineProps<{
	statusMessage: string | null;
	statusTone: StatusTone;
	isSaving: boolean;
	id?: string;
	/** When set, only show the badge for this tone (e.g. "error" for error-only panels). */
	showOnlyForTone?: StatusTone;
}>();
</script>
