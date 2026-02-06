<template>
	<div class="sms-preview">
		<h4 class="text-sm font-medium text-gray-700 mb-3">SMS Preview</h4>
		<div class="phone-mockup">
			<div class="phone-frame-border">
				<div class="phone-notch"></div>
				<div class="phone-screen">
					<div class="sms-body">
						<div class="message-bubble-received">
							<p class="text-sm leading-relaxed whitespace-pre-line">{{ formattedSmsText }}</p>
						</div>
					</div>
				</div>
			</div>
		</div>
	</div>
</template>

<script lang="ts" setup>
import { computed } from "vue";
import {
	type FormatPreferences,
	formatPreviewStocksList,
	type PreviewStock,
} from "./preview-data";

interface Props {
	stocks: PreviewStock[];
	formatPreferences: FormatPreferences;
}

const props = defineProps<Props>();

const formattedSmsText = computed(() =>
	`Your tracked stocks:\n${formatPreviewStocksList(props.stocks, props.formatPreferences)}`,
);
</script>

<style scoped>
.phone-mockup {
	max-width: 280px;
	margin: 0 auto;
}

.phone-frame-border {
	background: #1f2937;
	border-radius: 2rem;
	padding: 0.75rem 0.5rem;
	position: relative;
}

.phone-notch {
	width: 5rem;
	height: 0.375rem;
	background: #374151;
	border-radius: 9999px;
	margin: 0 auto 0.5rem;
}

.phone-screen {
	background: #f9fafb;
	border-radius: 1.25rem;
	overflow: hidden;
	min-height: 200px;
}

.sms-body {
	padding: 0.75rem;
}

.message-bubble-received {
	background: #e5e7eb;
	color: #1f2937;
	border-radius: 0.75rem 0.75rem 0.75rem 0.25rem;
	padding: 0.625rem 0.75rem;
	max-width: 90%;
	box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
}
</style>
