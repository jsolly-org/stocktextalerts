<template>
	<figure class="tg-preview" aria-label="Notification preview">
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

					<div class="tg-header" aria-hidden="true">
						<span class="tg-back">
							<ChevronLeftIcon aria-hidden="true" />
						</span>
						<div class="tg-title">
							<span class="tg-name">StockTextAlerts</span>
							<span class="tg-subtitle">bot</span>
						</div>
						<span class="tg-avatar">S</span>
					</div>

					<div class="tg-body">
						<!-- Scheduled price update — mirrors formatMarketScheduledTelegram: bold
						     header, then dot + bold ticker + price + signed change per asset. -->
						<div class="tg-bubble-received">
							<p class="tg-text tg-text-bold">📈 Price Update</p>
							<p v-for="line in telegramLines" :key="line.symbol" class="tg-text tg-line">
								{{ line.dot }} <strong>{{ line.symbol }}</strong>&ensp;{{ line.price }}&ensp;({{ line.change }})
							</p>
							<p class="tg-footer-text">{{ PREVIEW_FOOTER }}</p>
							<span class="tg-time" aria-hidden="true">9:41</span>
						</div>

						<!-- Price alert — the real candlestick SVG (the exact chart production
						     rasterizes to PNG for sendPhoto) with its caption. -->
						<div v-if="alert" class="tg-bubble-received tg-bubble-photo">
							<img
								:src="alert.svgDataUri"
								:alt="`Candlestick chart for ${alert.symbol}`"
								class="tg-chart"
								width="800"
								height="400"
							/>
							<div class="tg-caption">
								<p class="tg-text tg-text-bold">🚨 {{ alert.symbol }}</p>
								<p class="tg-text">{{ alert.headline }}</p>
								<p class="tg-footer-text">{{ PREVIEW_FOOTER }}</p>
								<span class="tg-time" aria-hidden="true">9:42</span>
							</div>
						</div>
					</div>
					<div class="phone-home-indicator" aria-hidden="true"></div>
				</div>
			</div>
		</div>
	</figure>
</template>

<script lang="ts" setup>
import { computed } from "vue";
// ?component suffix required: Astro Icon cannot be used in Vue; vite-svg-loader compiles this to a Vue component.
import ChevronLeftIcon from "../../../../icons/chevron-left.svg?component";
import { buildPreviewAlert, buildPreviewTelegramLines } from "./preview-data";
import type { PreviewAsset } from "./types";

// The preview is its own presentation artifact (channels own their formatting), so it
// carries a trimmed footer: the opt-out hint only, without the "Not financial advice."
// disclaimer the real Telegram messages send. Deliberately NOT the shared TELEGRAM_FOOTER.
const PREVIEW_FOOTER = "Send /stop to pause alerts.";

interface Props {
	assets: PreviewAsset[];
}

const props = defineProps<Props>();

const telegramLines = computed(() => buildPreviewTelegramLines(props.assets));
const alert = computed(() => {
	const first = props.assets[0];
	return first ? buildPreviewAlert(first) : null;
});
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
	background: #ffffff;
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
	background: #ffffff;
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

/* Telegram chat nav bar */
.tg-header {
	display: flex;
	align-items: center;
	gap: 0.5rem;
	padding: 0.35rem 0.75rem;
	background: #ffffff;
	border-bottom: 0.5px solid rgba(0, 0, 0, 0.12);
}

.tg-back {
	display: flex;
	align-items: center;
	color: #3390ec;
	flex-shrink: 0;
}

.tg-back svg {
	width: 0.9rem;
	height: 0.9rem;
}

.tg-title {
	display: flex;
	flex-direction: column;
	line-height: 1.1;
	flex: 1;
	min-width: 0;
}

.tg-name {
	font-size: 0.8rem;
	font-weight: 600;
	color: #0f172a;
	letter-spacing: -0.01em;
}

.tg-subtitle {
	font-size: 0.62rem;
	color: #8aa0b6;
}

.tg-avatar {
	flex-shrink: 0;
	width: 1.6rem;
	height: 1.6rem;
	border-radius: 50%;
	background: linear-gradient(135deg, #4facf5 0%, #2a7fd4 100%);
	color: #ffffff;
	font-size: 0.75rem;
	font-weight: 600;
	display: flex;
	align-items: center;
	justify-content: center;
	box-shadow: 0 1px 2px rgba(42, 127, 212, 0.3);
}

/* Chat wallpaper */
.tg-body {
	display: flex;
	flex-direction: column;
	gap: 0.55rem;
	padding: 0.7rem 0.7rem 1.3rem;
	background: linear-gradient(180deg, #d6e0eb 0%, #c9d6e5 100%);
	min-height: 200px;
}

.tg-bubble-received {
	background: #ffffff;
	color: #0f172a;
	border-radius: 1.05rem;
	border-bottom-left-radius: 0.25rem;
	padding: 0.45rem 0.65rem 0.5rem;
	max-width: 92%;
	position: relative;
	box-shadow: 0 1px 1px rgba(15, 23, 42, 0.12);
}

/* Photo message: image flush to the bubble top, caption below — Telegram's
   sendPhoto layout. */
.tg-bubble-photo {
	padding: 0;
	overflow: hidden;
}

.tg-chart {
	display: block;
	width: 100%;
	height: auto;
}

.tg-caption {
	padding: 0.4rem 0.65rem 0.5rem;
}

.tg-text {
	font-size: 0.78rem;
	line-height: 1.45;
	margin: 0;
}

.tg-text-bold {
	font-weight: 600;
}

.tg-line {
	font-variant-numeric: tabular-nums;
	white-space: nowrap;
}

.tg-footer-text {
	font-size: 0.62rem;
	line-height: 1.4;
	color: #8aa0b6;
	margin: 0.3rem 0 0;
}

.tg-time {
	display: block;
	text-align: right;
	font-size: 0.6rem;
	color: #8aa0b6;
	margin-top: 0.15rem;
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
		background: #17212b;
		border-color: rgba(255, 255, 255, 0.08);
	}

	.phone-status-bar {
		color: #e2e8f0;
		background: #17212b;
	}

	.tg-header {
		background: #17212b;
		border-bottom-color: rgba(255, 255, 255, 0.08);
	}

	.tg-name {
		color: #f1f5f9;
	}

	.tg-body {
		background: #0e1621;
	}

	.tg-bubble-received {
		background: #182533;
		color: #e5eaf0;
		box-shadow: 0 1px 1px rgba(0, 0, 0, 0.3);
	}

	.phone-home-indicator {
		background: rgba(226, 232, 240, 0.25);
	}
}
</style>
