<template>
	<div class="email-preview">
		<h4 class="text-sm font-medium text-gray-700 mb-3">Email Preview</h4>
		<div class="email-card">
			<div class="email-gradient-header">
				<span class="text-white text-lg font-semibold">StockTextAlerts</span>
			</div>
			<div class="email-body">
				<h3 class="text-gray-900 text-base font-semibold mt-0 mb-3">Your Update</h3>
				<div class="email-assets-section">
					<p
						class="text-gray-900 text-sm font-semibold m-0 font-mono leading-relaxed"
						v-html="formattedEmailHtml"
					></p>
				</div>
			</div>
		</div>
	</div>
</template>

<script lang="ts" setup>
import { computed } from "vue";
import type { FormatPreferences } from "../../../lib/messaging/types";
import {
	formatPreviewEmailHtml,
	type PreviewAsset,
} from "./preview-data";

interface Props {
	assets: PreviewAsset[];
	formatPreferences: FormatPreferences;
}

const props = defineProps<Props>();

const formattedEmailHtml = computed(() =>
	formatPreviewEmailHtml(props.assets, props.formatPreferences),
);
</script>

<style scoped>
.email-card {
	border: 1px solid #e5e7eb;
	border-radius: 0.5rem;
	overflow: hidden;
	background: #fff;
	box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
}

.email-gradient-header {
	background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
	padding: 1.25rem;
	text-align: center;
}

.email-body {
	padding: 1.25rem;
}

.email-assets-section {
	background: #f9fafb;
	padding: 0.75rem;
	border-radius: 0.375rem;
}

</style>
