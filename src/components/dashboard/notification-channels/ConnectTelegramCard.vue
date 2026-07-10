<template>
	<div class="rounded-lg border border-edge bg-surface-alt p-4">
		<div class="flex items-start justify-between gap-3">
			<div class="min-w-0">
				<h3 class="text-base font-semibold text-heading">Telegram</h3>
				<p class="mt-0.5 text-sm text-body-secondary">
					Receive your enabled notifications as Telegram bot messages.
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

		<div v-if="linkDetails" class="mt-3 space-y-3 rounded-lg border border-edge bg-surface p-3">
			<div>
				<p class="text-sm text-label">
					<strong class="font-semibold">Have the Telegram app?</strong> Open the link, then tap
					<strong class="font-semibold">Start</strong> (Telegram labels it “START BOT”) to finish
					connecting.
				</p>
				<a
					:href="linkDetails.deepLink"
					target="_blank"
					rel="noopener noreferrer"
					class="mt-2 inline-flex items-center gap-1.5 rounded text-sm font-medium text-primary hover:text-primary-strong hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1"
				>
					Open in Telegram app
					<ExternalLinkIcon class="size-4" aria-hidden="true" />
				</a>
				<p class="mt-1.5 break-all text-xs text-muted">{{ linkDetails.deepLink }}</p>
			</div>

			<div class="border-t border-edge pt-3">
				<p class="text-sm text-label">
					<strong class="font-semibold">Using Telegram in your browser?</strong> Open
					<a
						:href="linkDetails.webUrl"
						target="_blank"
						rel="noopener noreferrer"
						class="rounded font-medium text-primary hover:text-primary-strong hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1"
						>web.telegram.org</a
					>, open <span class="font-medium">@{{ linkDetails.botUsername }}</span>, and send this
					message:
				</p>
				<div class="mt-2 flex items-center gap-2">
					<code
						class="min-w-0 flex-1 break-all rounded border border-edge bg-surface-alt px-2 py-1.5 font-mono text-xs text-body"
						>{{ linkDetails.startCommand }}</code
					>
					<button
						type="button"
						class="btn btn-sm btn-secondary shrink-0"
						aria-label="Copy Telegram /start command"
						@click="copyStartCommand"
					>
						{{ copied ? "Copied" : "Copy" }}
					</button>
				</div>
				<span class="sr-only" aria-live="polite">{{ copied ? "Copied to clipboard" : "" }}</span>
			</div>
		</div>

		<StatusMessage v-if="errorMessage" tone="error" class="mt-3" :message="errorMessage" />
	</div>
</template>

<script lang="ts" setup>
import { computed, ref } from "vue";
import ExternalLinkIcon from "../../../icons/arrow-top-right-on-square.svg?component";
// ?component suffix required: Astro Icon cannot be used in Vue; vite-svg-loader compiles this to a Vue component.
import CheckCircleIcon from "../../../icons/check-circle-20.svg?component";
import { isUnauthorizedResponse, redirectToSignIn } from "../../../lib/auth/session/session-expired";
import { rootLogger } from "../../../lib/logging";
import StatusMessage from "../../StatusMessage.vue";
import { useDashboardUser } from "../composables/useDashboardUser";

const user = useDashboardUser();

/** Linked when the user has a Telegram chat id (set by the bot /start webhook). */
const isConnected = computed(() => user.value.telegram_chat_id != null);

/**
 * The link shape returned by `/api/telegram/link`. Browser-only users can't use
 * the deep link (it hands off to the desktop app, which they don't have), so the
 * server also hands back the raw `/start <token>` command and the web client URL.
 */
type LinkDetails = {
	deepLink: string;
	webUrl: string;
	botUsername: string;
	startCommand: string;
};

const isLinking = ref(false);
const linkDetails = ref<LinkDetails | null>(null);
const errorMessage = ref<string | null>(null);
const copied = ref(false);
let copyResetTimer: ReturnType<typeof setTimeout> | undefined;

async function copyStartCommand() {
	const command = linkDetails.value?.startCommand;
	if (!command) return;
	try {
		await navigator.clipboard.writeText(command);
		copied.value = true;
		clearTimeout(copyResetTimer);
		copyResetTimer = setTimeout(() => {
			copied.value = false;
		}, 2000);
	} catch (error) {
		rootLogger.error("Failed to copy Telegram start command", { action: "telegram_link" }, error);
	}
}

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
			webUrl?: string;
			botUsername?: string;
			startCommand?: string;
			message?: string;
		};

		if (
			!response.ok ||
			!payload.ok ||
			!payload.deepLink ||
			!payload.webUrl ||
			!payload.botUsername ||
			!payload.startCommand
		) {
			errorMessage.value = "Could not generate a Telegram link. Please try again.";
			rootLogger.error("Telegram link request failed", {
				action: "telegram_link",
				status: response.status,
				message: payload.message,
			});
			return;
		}

		linkDetails.value = {
			deepLink: payload.deepLink,
			webUrl: payload.webUrl,
			botUsername: payload.botUsername,
			startCommand: payload.startCommand,
		};
	} catch (error) {
		errorMessage.value = "Could not generate a Telegram link. Please try again.";
		rootLogger.error("Telegram link request errored", { action: "telegram_link" }, error);
	} finally {
		isLinking.value = false;
	}
}
</script>
