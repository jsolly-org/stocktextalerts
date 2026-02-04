import type { Logger } from "../logging";
import {
	createSmsSender,
	createTwilioClient,
	readTwilioConfig,
} from "../messaging/sms/twilio-utils";

interface SmsSenderResult {
	sender: ReturnType<typeof createSmsSender> | null;
	error?: string;
}

export type SmsSenderProvider = () => SmsSenderResult;

export function createSmsSenderProvider(logger: Logger): SmsSenderProvider {
	let twilioConfig: ReturnType<typeof readTwilioConfig> | null = null;
	let sendSms: ReturnType<typeof createSmsSender> | null = null;

	return () => {
		if (sendSms) {
			return { sender: sendSms };
		}

		try {
			if (!twilioConfig) {
				twilioConfig = readTwilioConfig();
			}
			const twilioClient = createTwilioClient(twilioConfig);
			sendSms = createSmsSender(twilioClient, twilioConfig.phoneNumber);
			return { sender: sendSms };
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			logger.error(
				"Failed to initialize Twilio client",
				{
					phase: "initTwilio",
					errorMessage: errorMsg,
					phoneNumber: twilioConfig?.phoneNumber,
				},
				error,
			);
			return { sender: null, error: errorMsg };
		}
	};
}
