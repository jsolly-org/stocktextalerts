import { createEmailSender, type EmailSender } from "./email/utils";
import { createLogoCache, type LogoCache } from "./logo-fetcher";
import { createSmsSenderFactory, type SmsSenderFactory } from "./sms/sender-factory";
import { createTelegramSenderFactory, type TelegramSenderFactory } from "./telegram/sender-factory";

/** Channel senders and logo cache created once per scheduler run or dispatch entry. */
export interface NotificationSenders {
	sendEmail: EmailSender;
	getSmsSender: SmsSenderFactory;
	getTelegramSender: TelegramSenderFactory;
	logoCache: LogoCache;
}

/** Build email/SMS/Telegram senders and a shared logo cache for notification pipelines. */
export function createNotificationSenders(): NotificationSenders {
	return {
		sendEmail: createEmailSender(),
		getSmsSender: createSmsSenderFactory(),
		getTelegramSender: createTelegramSenderFactory(),
		logoCache: createLogoCache(),
	};
}
