/**
 * Unit test for the read-only Telegram health check's result-shaping.
 *
 * Like the send-path tests, this installs a grammY transformer so the real
 * getMe()/getWebhookInfo() call path runs WITHOUT a real token or network: the
 * transformer answers each method with a canned response. This keeps the default
 * `npm test` suite mock-only — the live check (`checkTelegramLive` against a real
 * `TELEGRAM_BOT_TOKEN`) runs only inside the live-provider-check Lambda, never here.
 */
import type { Bot, Transformer } from "grammy";
import type { ApiResponse, UserFromGetMe, WebhookInfo } from "grammy/types";
import { describe, expect, it } from "vitest";
import { checkTelegramLive } from "../../../../src/lib/messaging/telegram/health";
import { createTelegramBot } from "../../../../src/lib/messaging/telegram/sender";

const FAKE_TOKEN = "123:fake-token-for-health-tests-only";

const ME = { id: 777, is_bot: true, username: "StockTextAlertsBot" } as UserFromGetMe;

function asApiResponse(response: ApiResponse<unknown>): ReturnType<Transformer> {
	return Promise.resolve(response) as ReturnType<Transformer>;
}

function mockBot(me: UserFromGetMe, webhook: WebhookInfo): Bot {
	const bot = createTelegramBot(FAKE_TOKEN);
	const transformer: Transformer = (_prev, method) => {
		if (method === "getMe") {
			return asApiResponse({ ok: true, result: me });
		}
		if (method === "getWebhookInfo") {
			return asApiResponse({ ok: true, result: webhook });
		}
		throw new Error(`unexpected method in health check: ${method}`);
	};
	bot.api.config.use(transformer);
	return bot;
}

function hangingBot(): Bot {
	const bot = createTelegramBot(FAKE_TOKEN);
	const transformer: Transformer = () => new Promise<never>(() => {});
	bot.api.config.use(transformer);
	return bot;
}

describe("checkTelegramLive drives the real getMe/getWebhookInfo path (transformer-mocked)", () => {
	it("returns the shaped report with username, webhook URL, backlog, and no error", async () => {
		const bot = mockBot(ME, {
			url: "https://stocktextalerts.com/api/messaging/telegram",
			has_custom_certificate: false,
			pending_update_count: 3,
		});
		const report = await checkTelegramLive(bot);
		expect(report).toEqual({
			ok: true,
			botId: 777,
			username: "StockTextAlertsBot",
			webhookUrl: "https://stocktextalerts.com/api/messaging/telegram",
			pendingUpdateCount: 3,
			lastError: null,
		});
	});

	it("surfaces the most recent webhook delivery error and an empty webhook URL", async () => {
		const bot = mockBot(ME, {
			has_custom_certificate: false,
			pending_update_count: 0,
			last_error_message: "Wrong response from the webhook: 500 Internal Server Error",
		});
		const report = await checkTelegramLive(bot);
		expect(report.webhookUrl).toBe("");
		expect(report.lastError).toBe("Wrong response from the webhook: 500 Internal Server Error");
	});

	it("flags ok=false when getMe returns no bot id", async () => {
		const bot = mockBot(
			{ ...ME, id: 0 },
			{
				has_custom_certificate: false,
				pending_update_count: 0,
			},
		);
		const report = await checkTelegramLive(bot);
		expect(report.ok).toBe(false);
	});

	it("returns the shaped report assembled from both probes", async () => {
		const bot = mockBot(ME, {
			url: "https://stocktextalerts.com/api/messaging/telegram",
			has_custom_certificate: false,
			pending_update_count: 1,
		});
		const report = await checkTelegramLive(bot);
		expect(report).toEqual({
			ok: true,
			botId: 777,
			username: "StockTextAlertsBot",
			webhookUrl: "https://stocktextalerts.com/api/messaging/telegram",
			pendingUpdateCount: 1,
			lastError: null,
		});
	});

	it("rejects with a clear timeout error when a probe stalls instead of hanging forever", async () => {
		const start = Date.now();
		await expect(checkTelegramLive(hangingBot(), { timeoutMs: 40 })).rejects.toThrow(
			/Telegram health check timed out after 40 ms/,
		);
		expect(Date.now() - start).toBeLessThan(5_000);
	});
});
