import {
	createSmsSender,
	createTwilioClient,
	readTwilioSenderConfig,
} from "../messaging/sms/twilio-utils";

interface SmsSenderResult {
	sender: ReturnType<typeof createSmsSender>;
}

export type SmsSenderProvider = () => SmsSenderResult;

/**
 * Create a lazily-initialized, cached SMS sender provider for scheduler runs.
 *
 * Caches config/sender to avoid per-user Twilio init during scheduler runs.
 */
export function createSmsSenderProvider(): SmsSenderProvider {
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
