/**
 * Email sender. Outbound sends pass through a shared 14 req/s limiter so concurrent
 * `createEmailSender()` instances never exceed SES's rate ceiling.
 */
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import nodemailer, { type Transporter } from "nodemailer";
import { readEnv, requireEnv } from "../../db/env";
import { rootLogger } from "../../logging";
import { createSlidingWindowLimiter } from "../../rate-limit";
import { withDeliveryRetry } from "../delivery-retry";
import { escapeHtml } from "../parts/html-utils";
import type { EmailSender } from "../types";

const EMAIL_MAX_PER_SECOND = 14;
const emailLimiter = createSlidingWindowLimiter({
	maxPerWindow: EMAIL_MAX_PER_SECOND,
	windowMs: 1_000,
});

/**
 * Create an email sender.
 *
 * When `EMAIL_SMTP_HOST` is set, routes through local SMTP (Mailpit) — used by
 * `astro dev` and live email tests. Otherwise sends via AWS SES.
 */
export function createEmailSender(): EmailSender {
	const fromEmail = requireEnv("EMAIL_FROM");
	const defaultReplyTo = readEnv("EMAIL_REPLY_TO");
	const smtpHost = readEnv("EMAIL_SMTP_HOST");

	if (smtpHost) {
		return createSmtpSender({ host: smtpHost, fromEmail, defaultReplyTo });
	}

	const sesClient = new SESv2Client({
		region: readEnv("AWS_REGION") || "us-east-1",
		maxAttempts: 1,
	});

	return async ({ to, subject, body, html, replyTo }) =>
		withDeliveryRetry(
			async () => {
				try {
					const replyToValue = replyTo || defaultReplyTo;
					const command = new SendEmailCommand({
						FromEmailAddress: fromEmail,
						Destination: { ToAddresses: [to] },
						ReplyToAddresses: replyToValue ? [replyToValue] : undefined,
						Content: {
							Simple: {
								Subject: { Data: subject, Charset: "UTF-8" },
								Body: {
									Text: { Data: body, Charset: "UTF-8" },
									Html: { Data: html ?? escapeHtml(body), Charset: "UTF-8" },
								},
							},
						},
					});
					await emailLimiter.acquire();
					// Per-attempt abort: a hung SES socket can otherwise park the Lambda.
					const response = await sesClient.send(command, {
						abortSignal: AbortSignal.timeout(30_000),
					});
					return { success: true, messageSid: response.MessageId };
				} catch (error) {
					return {
						success: false,
						error: error instanceof Error ? error.message : String(error),
						errorCode: error instanceof Error ? error.name : undefined,
					};
				}
			},
			{ channel: "email" },
		);
}

/**
 * SMTP-backed sender used when `EMAIL_SMTP_HOST` is set. Connects to
 * Mailpit (Supabase's bundled Inbucket container) by default. No auth,
 * no TLS — Mailpit is a local inbox, not a real SMTP relay.
 */
function createSmtpSender(options: {
	host: string;
	fromEmail: string;
	defaultReplyTo: string | undefined;
}): EmailSender {
	const port = Number.parseInt(readEnv("EMAIL_SMTP_PORT") || "1025", 10);
	const transporter: Transporter = nodemailer.createTransport({
		host: options.host,
		port,
		secure: false,
		ignoreTLS: true,
	});

	return async ({ to, subject, body, html, replyTo }) => {
		try {
			const info = await transporter.sendMail({
				from: options.fromEmail,
				to,
				replyTo: replyTo || options.defaultReplyTo,
				subject,
				text: body,
				html: html ?? escapeHtml(body),
			});
			return { success: true, messageSid: info.messageId };
		} catch (error) {
			// SMTP branch is dev/test-only (Mailpit) — never runs in prod, so
			// it can't trip ErrorLogAlarm. info because there's no retry to
			// escalate: it's just "your local Mailpit isn't running."
			rootLogger.info(
				"SMTP error sending email",
				{ action: "send_email_notification_smtp", host: options.host, port },
				error,
			);
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
				errorCode: error instanceof Error ? error.name : undefined,
			};
		}
	};
}
