import { createSmsSender, createTwilioClient, readTwilioSenderConfig } from "./twilio-utils";
import type { SmsSenderFactory } from "./types";

/**
 * Create a lazily-initialized, cached SMS sender factory for batch notification runs.
 *
 * Caches config/sender to avoid per-user Twilio init during cron passes.
 */
export function createSmsSenderFactory(): SmsSenderFactory {
	let twilioConfig: ReturnType<typeof readTwilioSenderConfig> | null = null;
	let sendSms: ReturnType<typeof createSmsSender> | null = null;

	return () => {
		if (sendSms) {
			return { sender: sendSms };
		}

		if (!twilioConfig) {
			twilioConfig = readTwilioSenderConfig();
		}
		const twilioClient = createTwilioClient(twilioConfig);
		sendSms = createSmsSender(twilioClient, twilioConfig.phoneNumber);
		return { sender: sendSms };
	};
}
