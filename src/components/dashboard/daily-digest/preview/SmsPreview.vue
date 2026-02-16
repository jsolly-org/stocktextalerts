<template>
	<div class="sms-preview" aria-label="SMS notification preview">
		<div class="phone-mockup">
			<div class="phone-frame-border">
				<div class="phone-screen">
					<div class="phone-status-bar" aria-hidden="true">
						<span class="status-time">9:41</span>
						<div class="status-icons">
							<svg class="status-icon" viewBox="0 0 17 12" fill="currentColor" aria-hidden="true"><rect x="0" y="8" width="3" height="4" rx="0.5"/><rect x="4.5" y="5" width="3" height="7" rx="0.5"/><rect x="9" y="2" width="3" height="10" rx="0.5"/><rect x="13.5" y="0" width="3" height="12" rx="0.5" opacity="0.3"/></svg>
							<svg class="status-icon" viewBox="0 0 16 12" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M1 4.5a10 10 0 0 1 14 0" stroke-linecap="round"/><path d="M4 7.5a6 6 0 0 1 8 0" stroke-linecap="round"/><circle cx="8" cy="11" r="1" fill="currentColor" stroke="none"/></svg>
							<svg class="status-icon-battery" viewBox="0 0 27 12" fill="currentColor" aria-hidden="true"><rect x="0" y="0.5" width="22" height="11" rx="2" stroke="currentColor" stroke-width="1.2" fill="none"/><rect x="2.5" y="2.5" width="14" height="7" rx="1"/><rect x="23" y="3.5" width="2" height="5" rx="1"/></svg>
						</div>
					</div>
					<div class="sms-body">
						<div class="message-bubble-received">
							<p class="text-sm leading-relaxed whitespace-pre-line">{{ formattedSmsText }}</p>
						</div>
					</div>
					<div class="phone-home-indicator" aria-hidden="true"></div>
				</div>
			</div>
		</div>
	</div>
</template>

<script lang="ts" setup>
import { computed } from "vue";
import type { FormatPreferences } from "../../../../lib/messaging/types";
import {
	formatPreviewAssetsList,
	type PreviewAsset,
} from "./preview-data";

interface Props {
	assets: PreviewAsset[];
	formatPreferences: FormatPreferences;
}

const props = defineProps<Props>();

const formattedSmsText = computed(() =>
	`Your tracked assets:\n${formatPreviewAssetsList(props.assets, props.formatPreferences)}`,
);
</script>

<style scoped>
.phone-mockup {
	max-width: 280px;
	margin: 0 auto;
}

.phone-frame-border {
	background: linear-gradient(160deg, #111827 0%, #1f2937 60%, #111827 100%);
	border-radius: 2.1rem;
	padding: 0.4rem;
	position: relative;
	box-shadow:
		inset 0 1px 0 rgba(255, 255, 255, 0.15),
		0 18px 28px -18px rgba(0, 0, 0, 0.55);
}

.phone-screen {
	background: linear-gradient(180deg, #f8fafc 0%, #f1f5f9 100%);
	border-radius: 1.75rem;
	overflow: hidden;
	min-height: 300px;
	position: relative;
	border: 1px solid rgba(255, 255, 255, 0.25);
}

.phone-status-bar {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 0.4rem 1rem 0.4rem;
	font-size: 0.75rem;
	font-weight: 600;
	color: #0f172a;
}

.status-icons {
	display: flex;
	align-items: center;
	gap: 0.4rem;
}

.status-icon {
	width: 0.95rem;
	height: 0.7rem;
}

.status-icon-battery {
	width: 1.3rem;
	height: 0.6rem;
}

.sms-body {
	padding: 0.2rem 0.75rem 1.2rem;
	background: #f1f5f9;
}

.message-bubble-received {
	background: #e5e7eb;
	color: #1f2937;
	border-radius: 1.125rem;
	border-bottom-left-radius: 0.125rem;
	padding: 0.5rem 0.75rem;
	max-width: 85%;
	position: relative;
	margin-left: 0.625rem;
}

.message-bubble-received::before {
	content: "";
	position: absolute;
	bottom: 0;
	left: -0.4375rem;
	height: 1.25rem;
	width: 1.25rem;
	background: #e5e7eb;
	border-bottom-right-radius: 0.9375rem;
}

.message-bubble-received::after {
	content: "";
	position: absolute;
	bottom: 0;
	left: -0.625rem;
	width: 0.625rem;
	height: 1.25rem;
	background: #f1f5f9;
	border-bottom-right-radius: 0.625rem;
}

.phone-home-indicator {
	position: absolute;
	left: 50%;
	bottom: 0.35rem;
	transform: translateX(-50%);
	width: 6.2rem;
	height: 0.2rem;
	background: rgba(15, 23, 42, 0.22);
	border-radius: 9999px;
}

@media (prefers-color-scheme: dark) {
	.phone-screen {
		background: linear-gradient(180deg, #1e293b 0%, #0f172a 100%);
		border-color: rgba(255, 255, 255, 0.08);
	}

	.phone-status-bar {
		color: #e2e8f0;
	}

	.sms-body {
		background: #0f172a;
	}

	.message-bubble-received {
		background: #374151;
		color: #e5e7eb;
	}

	.message-bubble-received::before {
		background: #374151;
	}

	.message-bubble-received::after {
		background: #0f172a;
	}

	.phone-home-indicator {
		background: rgba(226, 232, 240, 0.25);
	}
}
</style>
