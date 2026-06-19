<template>
	<div class="rounded-lg border border-edge bg-surface-alt p-4">
		<div class="flex items-start justify-between gap-3">
			<div class="min-w-0">
				<h3 class="text-base font-semibold text-heading">Telegram</h3>
				<p class="mt-0.5 text-sm text-body-secondary">
					Connect Telegram to receive your enabled notifications as bot messages.
				</p>
			</div>

			<span
				v-if="isConnected"
				class="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-success-bg px-2.5 py-1 text-xs font-medium text-success-text"
			>
				<CheckCircleIcon class="size-4" aria-hidden="true" />
				Connected
			</span>
		</div>

		<div class="mt-3">
			<button
				v-if="!isConnected"
				type="button"
				class="btn btn-md btn-primary"
				:class="{ 'btn-loading': isLinking }"
				:disabled="isLinking"
				@click="connect"
			>
				{{ isLinking ? "Generating link…" : "Connect Telegram" }}
			</button>

			<p v-else class="text-sm text-body-secondary">
				Your account is linked. Telegram appears as a channel option on every notification below.
			</p>
		</div>

		<div v-if="deepLink" class="mt-3 rounded-lg border border-edge bg-surface p-3">
			<p class="text-sm text-label">
				Open this link in Telegram and press <strong class="font-semibold">Start</strong> to finish connecting:
			</p>
			<a
				:href="deepLink"
				target="_blank"
				rel="noopener noreferrer"
				class="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:text-primary-strong hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 rounded"
			>
				Open in Telegram
				<ExternalLinkIcon class="size-4" aria-hidden="true" />
			</a>
			<p class="mt-1.5 break-all text-xs text-muted">{{ deepLink }}</p>
		</div>

		<StatusMessage v-if="errorMessage" tone="error" class="mt-3" :message="errorMessage" />
	</div>
</template>

<script lang="ts" setup>
import { computed, ref } from "vue";
import ExternalLinkIcon from "../../../icons/arrow-top-right-on-square.svg?component";
// ?component suffix required: Astro Icon cannot be used in Vue; vite-svg-loader compiles this to a Vue component.
import CheckCircleIcon from "../../../icons/check-circle-20.svg?component";
import { isUnauthorizedResponse, redirectToSignIn } from "../../../lib/auth/session-expired";
import { rootLogger } from "../../../lib/logging";
import StatusMessage from "../../StatusMessage.vue";
import { useDashboardUser } from "../composables/useDashboardUser";

const user = useDashboardUser();

/** Linked when the user has a Telegram chat id (set by the bot /start webhook). */
const isConnected = computed(() => user.value.telegram_chat_id != null);

const isLinking = ref(false);
const deepLink = ref<string | null>(null);
const errorMessage = ref<string | null>(null);

/**
 * Mint a single-use linking deep link and surface it. The bot's /start webhook
 * consumes the token and sets `telegram_chat_id`; in this prototype the connected
 * state flips after the user reloads the dashboard (server re-reads the column).
 */
async function connect() {
	if (isLinking.value) return;
	isLinking.value = true;
	errorMessage.value = null;
	try {
		const response = await fetch("/api/telegram/link", {
			method: "POST",
			credentials: "same-origin",
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(10_000),
		});

		if (isUnauthorizedResponse(response)) {
			redirectToSignIn();
			return;
		}

		const payload = (await response.json()) as {
			ok: boolean;
			deepLink?: string;
			message?: string;
		};

		if (!response.ok || !payload.ok || !payload.deepLink) {
			errorMessage.value = "Could not generate a Telegram link. Please try again.";
			rootLogger.error("Telegram link request failed", {
				action: "telegram_link",
				status: response.status,
				message: payload.message,
			});
			return;
		}

		deepLink.value = payload.deepLink;
	} catch (error) {
		errorMessage.value = "Could not generate a Telegram link. Please try again.";
		rootLogger.error("Telegram link request errored", { action: "telegram_link" }, error);
	} finally {
		isLinking.value = false;
	}
}
</script>
