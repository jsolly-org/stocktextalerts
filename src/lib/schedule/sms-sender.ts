import {
	createSmsSender,
	createTwilioClient,
	readTwilioConfig,
} from "../messaging/sms/twilio-utils";

interface SmsSenderResult {
	sender: ReturnType<typeof createSmsSender>;
}

export type SmsSenderProvider = () => SmsSenderResult;

/**
 * Create a lazily-initialized, cached SMS sender provider for scheduler runs.
 *
 * Caches config/sender to avoid per-user Twilio init during scheduler runs.
 *
 * Non-production builds short-circuit before reading any `TWILIO_*`
 * environment variables. The hard gate inside `createSmsSender` already
 * blocks real API calls, but gating here as well means a clean checkout
 * with no Twilio credentials can still run the full scheduler pipeline
 * in tests — `requireEnv("TWILIO_ACCOUNT_SID")` never fires.
 */
export function createSmsSenderProvider(): SmsSenderProvider {
	let twilioConfig: ReturnType<typeof readTwilioConfig> | null = null;
	let sendSms: ReturnType<typeof createSmsSender> | null = null;

	return () => {
		if (sendSms) {
			return { sender: sendSms };
		}

		if (import.meta.env.MODE !== "production") {
			// Pass a sentinel client object — the mock branch inside
			// createSmsSender ignores the `client` arg entirely, so this
			// never touches the Twilio SDK.
			sendSms = createSmsSender(
				null as unknown as ReturnType<typeof createTwilioClient>,
				"+15005550006",
			);
			return { sender: sendSms };
		}

		if (!twilioConfig) {
			twilioConfig = readTwilioConfig();
		}
		const twilioClient = createTwilioClient(twilioConfig);
		sendSms = createSmsSender(twilioClient, twilioConfig.phoneNumber);
		return { sender: sendSms };
	};
}
