import type { Context, ScheduledEvent } from "aws-lambda";
import { createLogger } from "../lib/logging";
import { runWithRequestContext } from "../lib/logging/request-context";
import { fetchDailyCloses, fetchEarnings, fetchPrevClose } from "../lib/providers/massive";
import { fetchAssetPrices, getCurrentMarketSession } from "../lib/providers/price-fetcher";

/**
 * Scheduled live data-provider health check (Massive + Finnhub).
 *
 * This is the only place real provider round-trips run — against the real
 * Massive/Finnhub APIs during market hours, when snapshot data is fresh — and
 * throws on any failure. (There is no local live-test tier; provider keys exist
 * only in this Lambda's env.) The thrown error surfaces on the
 * `AWS/Lambda Errors` metric, which `LiveProviderCheckFunctionErrorAlarm` routes
 * to the shared-infra SNS topic (same enriched-email path as every other
 * function alarm). Provider keys come from the function's env (SAM params),
 * exactly like the other scheduled Lambdas.
 */

interface CheckResult {
	name: string;
	ok: boolean;
	detail: string;
}

function isoDaysFromNow(days: number): string {
	return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function runCheck(name: string, fn: () => Promise<void>): Promise<CheckResult> {
	try {
		await fn();
		return { name, ok: true, detail: "ok" };
	} catch (error) {
		return { name, ok: false, detail: error instanceof Error ? error.message : String(error) };
	}
}

export async function handler(event: ScheduledEvent, context: Context): Promise<void> {
	return runWithRequestContext(context.awsRequestId, async () => {
		const logger = createLogger({
			source: "lambda",
			function: "live-provider-check",
			gitSha: process.env.GIT_SHA,
		});
		logger.info("Lambda invoke", {
			action: "lambda_invoke",
			eventId: event.id,
			eventTime: event.time,
		});

		const checks: CheckResult[] = [
			await runCheck("massive:prev-close", async () => {
				const prev = await fetchPrevClose("SPY");
				if (prev === null || !Number.isFinite(prev) || prev <= 0) {
					throw new Error(`fetchPrevClose(SPY) returned ${prev}`);
				}
			}),
			await runCheck("massive:asset-prices", async () => {
				const session = await getCurrentMarketSession();
				const prices = await fetchAssetPrices(["SPY", "AAPL"], session);
				if (prices.size !== 2) {
					throw new Error(`fetchAssetPrices returned ${prices.size}/2 symbols`);
				}
			}),
			await runCheck("massive:daily-closes", async () => {
				const closes = await fetchDailyCloses("SPY", isoDaysFromNow(-7), isoDaysFromNow(0));
				if (!closes || closes.length === 0) {
					throw new Error("fetchDailyCloses(SPY) returned no closes");
				}
			}),
			await runCheck("finnhub:earnings", async () => {
				const result = await fetchEarnings(isoDaysFromNow(0), isoDaysFromNow(14));
				if (result.failed) {
					throw new Error("fetchEarnings reported failed=true");
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
