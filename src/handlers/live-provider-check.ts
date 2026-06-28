import type { Context, ScheduledEvent } from "aws-lambda";
import { HttpError } from "grammy";
import { fetchEarnings } from "../lib/asset-events/earnings";
import { createLogger, type Logger } from "../lib/logging";
import { runLambda } from "../lib/logging/request-context";
import { fetchDailyCloses, fetchPrevClose } from "../lib/market-data/bars";
import { fetchAssetPrices } from "../lib/market-data/prices";
import { getCurrentMarketSession } from "../lib/market-data/session";
import { checkTelegramLive } from "../lib/messaging/telegram/health";
import { createTelegramBot, readTelegramBotToken } from "../lib/messaging/telegram/sender";

/**
 * Scheduled live data-provider health check (Massive + Finnhub + Telegram).
 *
 * This is the only place real provider round-trips run — against the real
 * Massive/Finnhub APIs during market hours, when snapshot data is fresh, plus a
 * read-only Telegram token check — and throws on any failure. (There is no local
 * live-test tier; provider keys + the bot token exist only in this Lambda's env.)
 * The Telegram check is deliberately side-effect-free: it calls only the read-only
 * `getMe()` + `getWebhookInfo()` Bot-API methods (never sendMessage/sendPhoto), so
 * an agent invoking this Lambda can never trigger a real message. The thrown error
 * surfaces on the `AWS/Lambda Errors` metric, which `LiveProviderCheckFunctionErrorAlarm`
 * routes to the shared-infra SNS topic (same enriched-email path as every other
 * function alarm). Provider keys + the bot token are fetched at runtime from SSM
 * SecureString (via loadSecretsIntoEnv → src/lib/secrets.ts), like the other
 * scheduled Lambdas, and exist only in this Lambda's runtime.
 */

interface CheckResult {
	name: string;
	ok: boolean;
	detail: string;
}

function isoDaysFromNow(days: number): string {
	return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * Run one check and log its outcome + wall-clock duration as a discrete step event.
 * The original version logged nothing per check, so the unbounded Telegram hang was
 * invisible — the log jumped straight from "Lambda invoke" to the 300s timeout. With
 * per-step timing, a slow or failing provider is attributable from the logs alone.
 * Steps log at `info` (even failures): the aggregate `error` + thrown exception below
 * is what escalates and pages; a single step result is just lifecycle telemetry.
 */
async function runCheck(
	logger: Logger,
	name: string,
	fn: () => Promise<void>,
): Promise<CheckResult> {
	const startedAt = Date.now();
	try {
		await fn();
		logger.info("Live provider check step", {
			action: "live_provider_check_step",
			check: name,
			ok: true,
			durationMs: Date.now() - startedAt,
		});
		return { name, ok: true, detail: "ok" };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		logger.info("Live provider check step", {
			action: "live_provider_check_step",
			check: name,
			ok: false,
			durationMs: Date.now() - startedAt,
			detail,
		});
		return { name, ok: false, detail };
	}
}

export async function handler(event: ScheduledEvent, context: Context): Promise<void> {
	return runLambda(context, async () => {
		const logger = createLogger({
			source: "lambda",
			function: "live-provider-check",
		});
		logger.info("Lambda invoke", {
			action: "lambda_invoke",
			eventId: event.id,
			eventTime: event.time,
		});

		const checks: CheckResult[] = [
			await runCheck(logger, "massive:prev-close", async () => {
				const prev = await fetchPrevClose("SPY");
				if (prev === null || !Number.isFinite(prev) || prev <= 0) {
					throw new Error(`fetchPrevClose(SPY) returned ${prev}`);
				}
			}),
			await runCheck(logger, "massive:asset-prices", async () => {
				const session = await getCurrentMarketSession();
				const prices = await fetchAssetPrices(["SPY", "AAPL"], session);
				if (prices.size !== 2) {
					throw new Error(`fetchAssetPrices returned ${prices.size}/2 symbols`);
				}
			}),
			await runCheck(logger, "massive:daily-closes", async () => {
				const closes = await fetchDailyCloses("SPY", isoDaysFromNow(-7), isoDaysFromNow(0));
				if (!closes || closes.length === 0) {
					throw new Error("fetchDailyCloses(SPY) returned no closes");
				}
			}),
			await runCheck(logger, "finnhub:earnings", async () => {
				const result = await fetchEarnings(isoDaysFromNow(0), isoDaysFromNow(14));
				if (result.failed) {
					throw new Error("fetchEarnings reported failed=true");
				}
			}),
			await runCheck(logger, "telegram:get-me", async () => {
				// Read-only getMe()/getWebhookInfo() — undici reaches api.telegram.org where
				// grammY's node-fetch stalled (see createTelegramBot). No auto-retry: a one-shot
				// probe must fail fast with the real cause.
				const bot = createTelegramBot(readTelegramBotToken(), {
					timeoutSeconds: 10,
					withAutoRetry: false,
				});
				const report = await checkTelegramLive(bot).catch((error: unknown) => {
					// Surface the transport cause (undici throws a TypeError with .cause.code like
					// ENETUNREACH). grammY's HttpError.message is generic and `sensitiveLogs` would
					// leak the token — so unwrap .error manually. Learning WHY undici fails (if it
					// does) is the entire point of this check.
					if (error instanceof HttpError && error.error instanceof Error) {
						const code = (error.error.cause as { code?: string } | undefined)?.code;
						throw new Error(
							`telegram transport error: ${error.error.message}${code ? ` [${code}]` : ""}`,
						);
					}
					throw error;
				});
				if (!report.ok) {
					throw new Error(`getMe() returned no bot id (botId=${report.botId})`);
				}
			}),
		];

		const failed = checks.filter((c) => !c.ok);
		if (failed.length > 0) {
			logger.error("Live provider checks failed", {
				action: "live_provider_check",
				failedCount: failed.length,
				totalCount: checks.length,
				failures: failed.map((c) => ({ name: c.name, detail: c.detail })),
			});
			// Throw so AWS/Lambda Errors fires LiveProviderCheckFunctionErrorAlarm
			// → shared-infra SNS → enriched failure email.
			throw new Error(
				`Live provider checks failed (${failed.length}/${checks.length}): ${failed
					.map((c) => `${c.name} (${c.detail})`)
					.join("; ")}`,
			);
		}

		logger.info("Live provider checks passed", {
			action: "live_provider_check",
			totalCount: checks.length,
			checks: checks.map((c) => c.name),
		});
	});
}
