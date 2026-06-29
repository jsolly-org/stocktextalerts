/**
 * Module-level rate limiter for outbound email (14 req/s default).
 * Shared across all `createEmailSender()` instances so concurrent callers
 * never exceed the global rate limit.
 *
 * Uses `node:timers/promises` so the delay works even when vitest's
 * `vi.useFakeTimers()` has replaced the global `setTimeout`.
 * Uses `performance.now()` instead of `Date.now()` because vitest's
 * fake timers replace `Date.now()` but not `performance.now()`.
 */
import { setTimeout as realDelay } from "node:timers/promises";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import nodemailer, { type Transporter } from "nodemailer";
import { readEnv, requireEnv } from "../../db/env";
import { rootLogger } from "../../logging";
import type { DeliveryResult } from "../../types";
import { withDeliveryRetry } from "../delivery-retry";
import { escapeHtml } from "../parts/html-utils";

const EMAIL_MAX_PER_SECOND = 14;
const recentSendTimestamps: number[] = [];

/** Serialize check/wait/push so concurrent waiters don't all proceed after the same delay and exceed the limit. */
let mutexPromise = Promise.resolve<void>(undefined);
async function acquireMutex(): Promise<() => void> {
	const prev = mutexPromise;
	let release!: () => void;
	mutexPromise = new Promise<void>((r) => {
		release = r;
	});
	await prev;
	return release;
}

async function waitForRateLimit(): Promise<void> {
	for (;;) {
		const release = await acquireMutex();
		let waitMs = 0;
		let shouldWait = false;
		try {
			const now = performance.now();
			while (recentSendTimestamps.length > 0) {
				const oldest = recentSendTimestamps[0];
				if (oldest === undefined || oldest > now - 1000) break;
				recentSendTimestamps.shift();
			}
			if (recentSendTimestamps.length < EMAIL_MAX_PER_SECOND) {
				recentSendTimestamps.push(performance.now());
				return;
			}
			const earliest = recentSendTimestamps[0];
			if (earliest !== undefined) {
				waitMs = earliest + 1000 - now;
				shouldWait = waitMs > 0;
			}
		} finally {
			release();
		}
		if (shouldWait) await realDelay(waitMs);
	}
}

export interface EmailRequest {
	to: string;
	subject: string;
	body: string;
	html?: string;
	idempotencyKey?: string;
	replyTo?: string;
	userId?: string;
}

export type EmailSender = (request: EmailRequest) => Promise<DeliveryResult>;

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
					await waitForRateLimit();
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
