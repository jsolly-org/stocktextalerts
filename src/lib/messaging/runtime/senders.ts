import type { EmailSender } from "../email/types";
import { createEmailSender } from "../email/utils";
import { createLogoCache } from "../logo-fetcher";
import { createSmsSenderFactory } from "../sms/sender-factory";
import type { SmsSenderFactory } from "../sms/types";
import { createTelegramSenderFactory } from "../telegram/sender-factory";
import type { TelegramSenderFactory } from "../telegram/types";
import type { LogoCache } from "../types";

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
