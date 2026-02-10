<template>
	<div class="email-preview">
		<h3 class="sr-only">Email</h3>
		<div class="email-card">
			<div class="email-client-toolbar" aria-hidden="true">
				<span class="toolbar-dot"></span>
				<span class="toolbar-dot"></span>
				<span class="toolbar-dot"></span>
				<span class="toolbar-title">Inbox</span>
			</div>
			<div class="email-body">
				<div class="email-assets-section">
					<p
						class="email-assets-content"
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
	border: 1px solid #dbe4f0;
	border-radius: 0.625rem;
	overflow: hidden;
	background: #fff;
	box-shadow: 0 4px 12px rgba(30, 41, 59, 0.08);
}

.email-client-toolbar {
	display: flex;
	align-items: center;
	gap: 0.375rem;
	padding: 0.5rem 0.75rem;
	background: linear-gradient(90deg, #eef2ff 0%, #f8fafc 100%);
	border-bottom: 1px solid #dbe4f0;
}

.toolbar-dot {
	width: 0.5rem;
	height: 0.5rem;
	border-radius: 9999px;
	background: #cbd5e1;
}

.toolbar-dot:nth-child(1) {
	background: #fca5a5;
}

.toolbar-dot:nth-child(2) {
	background: #fcd34d;
}

.toolbar-dot:nth-child(3) {
	background: #86efac;
}

.toolbar-title {
	margin-left: 0.375rem;
	font-size: 0.75rem;
	font-weight: 600;
	color: #4338ca;
	letter-spacing: 0.01em;
}

.email-body {
	padding: 1.25rem;
	background: #ffffff;
	border-top: none;
}

.email-assets-section {
	background: #f9fafb;
	padding: 0.875rem;
	border-radius: 0.375rem;
	border: 1px solid #e2e8f0;
}

.email-assets-content {
	color: #1f2937;
	font-size: 0.9rem;
	font-weight: 600;
	margin: 0;
	line-height: 1.55;
	font-family:
		"Courier New", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
		"Liberation Mono", monospace;
}

</style>
