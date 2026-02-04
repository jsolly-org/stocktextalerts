import {
	createSmsSender,
	createTwilioClient,
	readTwilioConfig,
} from "../messaging/sms/twilio-utils";

interface SmsSenderResult {
	sender: ReturnType<typeof createSmsSender>;
}

export type SmsSenderProvider = () => SmsSenderResult;

export function createSmsSenderProvider(): SmsSenderProvider {
	let twilioConfig: ReturnType<typeof readTwilioConfig> | null = null;
	let sendSms: ReturnType<typeof createSmsSender> | null = null;

	return () => {
		// Cache config/sender to avoid per-user Twilio init during scheduler runs.
		if (sendSms) {
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
