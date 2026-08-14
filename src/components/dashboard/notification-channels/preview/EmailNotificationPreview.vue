<template>
	<figure class="mail-preview" aria-label="Email notification preview">
		<div class="mail-window">
			<div class="mail-chrome" aria-hidden="true">
				<span class="traffic-lights">
					<span class="traffic-light traffic-close"></span>
					<span class="traffic-light traffic-minimize"></span>
					<span class="traffic-light traffic-zoom"></span>
				</span>
			</div>

			<header class="mail-headers">
				<p class="mail-subject">{{ PREVIEW_EMAIL_SUBJECT }}</p>
				<div class="mail-meta">
					<span class="mail-from-avatar" aria-hidden="true">S</span>
					<div class="mail-from">
						<p class="mail-from-name">StockTextAlerts</p>
						<p class="mail-from-to">to you</p>
					</div>
					<time class="mail-time" :datetime="previewTimeIso">{{ previewTimeLabel }}</time>
				</div>
			</header>

			<!-- Body stays light: production emails set color-scheme: light. -->
			<div class="mail-body">
				<div class="email-banner">
					<p class="email-banner-title">{{ PREVIEW_EMAIL_SUBJECT }}</p>
				</div>
				<div class="email-content">
					<p class="email-recency">{{ recencyText }}</p>
					<h3 class="email-heading">Your Scheduled Price Notification</h3>
					<ul class="email-assets">
						<li v-for="row in emailRows" :key="row.symbol" class="email-asset">
							<div class="email-asset-row">
								<span class="email-ticker">{{ row.symbol }}</span>
								<span class="email-dash" aria-hidden="true">&mdash;</span>
								<span class="email-price">{{ row.price }}</span>
								<span class="email-change" :style="{ color: row.changeColor }">{{
									row.change
								}}</span>
							</div>
							<p v-if="row.sparklineSrc" class="email-sparkline">
								<span class="email-sparkline-label">{{ row.sparklineLabel }}:</span>
								<img
									:src="row.sparklineSrc"
									:alt="`${row.sparklineLabel} price trend for ${row.symbol}`"
									width="80"
									height="20"
								/>
							</p>
						</li>
					</ul>
					<p class="email-cta">Manage your notifications →</p>
					<p class="email-footer">Adjust delivery schedule · Unsubscribe from all emails</p>
				</div>
			</div>
		</div>
	</figure>
</template>

<script lang="ts" setup>
import { computed } from "vue";
import { buildDataRecencyText } from "../../../../lib/messaging/parts/data-recency";
import { formatMinutesAsLocalTime } from "../../../../lib/time/display";
import { useDashboardUser } from "../../composables/useDashboardUser";
import { buildPreviewEmailRows, PREVIEW_EMAIL_SUBJECT } from "./preview-data";
import type { PreviewAsset } from "./types";

const PREVIEW_MINUTE = 9 * 60 + 41;

interface Props {
	assets: PreviewAsset[];
}

const props = defineProps<Props>();

const user = useDashboardUser();
const recencyText = buildDataRecencyText();
const emailRows = computed(() => buildPreviewEmailRows(props.assets));
const previewTimeLabel = computed(() =>
	formatMinutesAsLocalTime(PREVIEW_MINUTE, user.value.use_24_hour_time),
);
const previewTimeIso = "09:41";
</script>

<style scoped>
.mail-preview {
	width: 100%;
	max-width: 22rem;
	margin: 0 auto;
}

.mail-window {
	border-radius: 0.75rem;
	overflow: hidden;
	border: 1px solid #e5e7eb;
	background: #ffffff;
	box-shadow: 0 18px 28px -18px rgba(0, 0, 0, 0.45);
}

.mail-chrome {
	display: flex;
	align-items: center;
	gap: 0.75rem;
	padding: 0.45rem 0.7rem;
	background: #f3f4f6;
	border-bottom: 1px solid #e5e7eb;
}

.traffic-lights {
	display: flex;
	align-items: center;
	gap: 0.35rem;
	flex-shrink: 0;
}

.traffic-light {
	width: 0.6rem;
	height: 0.6rem;
	border-radius: 9999px;
}

.traffic-close {
	background: #ff5f57;
}

.traffic-minimize {
	background: #febc2e;
}

.traffic-zoom {
	background: #28c840;
}

.mail-headers {
	padding: 0.7rem 0.85rem 0.65rem;
	background: #ffffff;
	border-bottom: 1px solid #e5e7eb;
}

.mail-subject {
	margin: 0 0 0.55rem;
	font-size: 0.95rem;
	font-weight: 700;
	color: #111827;
	letter-spacing: -0.01em;
}

.mail-meta {
	display: flex;
	align-items: center;
	gap: 0.5rem;
}

.mail-from-avatar {
	flex-shrink: 0;
	width: 1.7rem;
	height: 1.7rem;
	border-radius: 50%;
	background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
	color: #ffffff;
	font-size: 0.75rem;
	font-weight: 600;
	display: flex;
	align-items: center;
	justify-content: center;
}

.mail-from {
	flex: 1;
	min-width: 0;
	line-height: 1.2;
}

.mail-from-name {
	margin: 0;
	font-size: 0.75rem;
	font-weight: 600;
	color: #111827;
}

.mail-from-to {
	margin: 0.1rem 0 0;
	font-size: 0.65rem;
	color: #6b7280;
}

.mail-time {
	flex-shrink: 0;
	font-size: 0.65rem;
	color: #6b7280;
}

.mail-body {
	background: #f3f4f6;
	padding: 0.7rem;
}

.email-banner {
	background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
	padding: 0.85rem 0.7rem;
	border-radius: 0.5rem 0.5rem 0 0;
	text-align: center;
}

.email-banner-title {
	margin: 0;
	color: #ffffff;
	font-size: 0.95rem;
	font-weight: 600;
}

.email-content {
	background: #ffffff;
	padding: 0.85rem 0.75rem 0.75rem;
	border: 1px solid #e5e7eb;
	border-top: none;
	border-radius: 0 0 0.5rem 0.5rem;
}

.email-recency {
	margin: 0 0 0.75rem;
	background: #eff6ff;
	border: 1px solid #93c5fd;
	border-radius: 0.5rem;
	padding: 0.4rem 0.55rem;
	text-align: center;
	color: #1e40af;
	font-size: 0.62rem;
}

.email-heading {
	margin: 0 0 0.65rem;
	color: #1f2937;
	font-size: 0.82rem;
	font-weight: 600;
}

.email-assets {
	list-style: none;
	margin: 0;
	padding: 0.65rem 0.7rem;
	background: #f9fafb;
	border-radius: 0.4rem;
}

.email-asset + .email-asset {
	margin-top: 0.55rem;
	padding-top: 0.55rem;
	border-top: 1px solid #e5e7eb;
}

.email-asset-row {
	display: flex;
	align-items: baseline;
	gap: 0.35rem;
	font-size: 0.72rem;
	color: #1f2937;
	font-variant-numeric: tabular-nums;
}

.email-ticker {
	font-weight: 700;
}

.email-dash {
	color: #9ca3af;
}

.email-price {
	font-weight: 700;
}

.email-change {
	font-weight: 500;
}

.email-sparkline {
	display: flex;
	align-items: center;
	gap: 0.35rem;
	margin: 0.2rem 0 0;
}

.email-sparkline-label {
	color: #6b7280;
	font-size: 0.58rem;
}

.email-sparkline img {
	display: block;
	width: 5rem;
	max-width: 100%;
	height: auto;
}

.email-cta {
	margin: 0.85rem 0 0;
	text-align: center;
	color: #4338ca;
	font-size: 0.7rem;
	font-weight: 500;
}

.email-footer {
	margin: 0.7rem 0 0;
	padding-top: 0.55rem;
	border-top: 1px solid #e5e7eb;
	color: #6b7280;
	font-size: 0.58rem;
	text-align: center;
}

@media (prefers-color-scheme: dark) {
	.mail-window {
		border-color: rgba(255, 255, 255, 0.1);
		background: #1f2937;
	}

	.mail-chrome {
		background: #111827;
		border-bottom-color: rgba(255, 255, 255, 0.08);
	}

	.mail-headers {
		background: #1f2937;
		border-bottom-color: rgba(255, 255, 255, 0.08);
	}

	.mail-subject,
	.mail-from-name {
		color: #f9fafb;
	}

	.mail-from-to,
	.mail-time {
		color: #9ca3af;
	}

	.mail-body {
		background: #111827;
	}
}
</style>
