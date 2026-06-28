import { vi } from "vitest";

/** Reapply baseline vi.stubEnv values from tests/setup.ts after scoped env tests. */
export function restoreBaselineTestEnvStubs(): void {
	vi.stubEnv("MASSIVE_API_KEY", "test-massive-key");
	vi.stubEnv("FINNHUB_API_KEY", "test-finnhub-key");
	vi.stubEnv("XAI_API_KEY", "");
	vi.stubEnv("UNSUBSCRIBE_TOKEN_SECRET", "test-unsubscribe-secret");
	vi.stubEnv("TELEGRAM_LINK_TOKEN_SECRET", "test-telegram-link-token-secret");
	vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "test-telegram-webhook-secret");
	vi.stubEnv("TELEGRAM_BOT_USERNAME", "StockTextAlertsTestBot");
	vi.stubEnv("TELEGRAM_BOT_TOKEN", "123456:test-telegram-bot-token");
	vi.stubEnv("TWILIO_ACCOUNT_SID", "ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
	vi.stubEnv("TWILIO_API_KEY_SID", "SKaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
	vi.stubEnv("TWILIO_API_KEY_SECRET", "stubaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
	vi.stubEnv("TWILIO_PHONE_NUMBER", "+15005550006");
	vi.stubEnv("TWILIO_VERIFY_SERVICE_SID", "VAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
	delete process.env.EMAIL_DISPATCH_URL;
	delete process.env.EMAIL_DISPATCH_SECRET;
	delete process.env.SKIP_VENDOR_HTTP_IN_TEST;
}

/** Clear custom env overrides then restore the suite baseline. */
export function resetTestEnvStubs(): void {
	vi.unstubAllEnvs();
	restoreBaselineTestEnvStubs();
}
