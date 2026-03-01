import {
	createSmsClient,
	createSmsSender,
	readSmsConfig,
} from "../messaging/sms/aws-sms-utils";

interface SmsSenderResult {
	sender: ReturnType<typeof createSmsSender>;
}

export type SmsSenderProvider = () => SmsSenderResult;

/**
 * Create a lazily-initialized, cached SMS sender provider for scheduler runs.
 *
 * This avoids re-reading config and re-initializing the SMS client for every user processed.
 */
export function createSmsSenderProvider(): SmsSenderProvider {
	let smsConfig: ReturnType<typeof readSmsConfig> | null = null;
	let sendSms: ReturnType<typeof createSmsSender> | null = null;

	return () => {
		// Cache config/sender to avoid per-user SMS init during scheduler runs.
		if (sendSms) {
			return { sender: sendSms };
		}

		if (!smsConfig) {
			smsConfig = readSmsConfig();
		}
		const smsClient = createSmsClient(smsConfig);
		sendSms = createSmsSender(smsClient, smsConfig.originationIdentity);
		return { sender: sendSms };
	};
}
