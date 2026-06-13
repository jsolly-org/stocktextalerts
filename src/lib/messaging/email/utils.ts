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
import {
	buildSessionFirstLine,
	buildSessionFirstLineHtml,
} from "../../market-notifications/scheduled/session-label";
import type { AssetPriceMap, MarketSession } from "../../providers/price-fetcher";
import { NO_SESSION_TRADE } from "../../providers/price-fetcher";
import { isProduction } from "../../runtime/mode";
import { escapeHtml, formatAssetsHtmlList } from "../asset-formatting";
import { withDeliveryRetry } from "../delivery-retry";
import { buildMarketClosedBannerHtml, buildMarketClosedBannerText } from "../market-closure-banner";
import type { DeliveryResult, EmailFormatContext, EmailUser, UserAssetRow } from "../types";

const EMAIL_MAX_PER_SECOND = 14;
const recentSendTimestamps: number[] = [];

/** Serialize check/wait/push so concurrent waiters don't all proceed after the same delay and exceed the limit. */
let mutexPromise = Promise.resolve<void>(undefined);
function acquireMutex(): Promise<() => void> {
	const prev = mutexPromise;
	let release!: () => void;
	mutexPromise = new Promise<void>((r) => {
		release = r;
	});
	return prev.then(() => release);
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

import { buildEmailUrls } from "./layout";

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
 * Three branches, in order:
 *  1. `EMAIL_SMTP_HOST` set → route through local SMTP (Mailpit). Used by
 *     `astro dev` and by live email tests; inspect at http://localhost:54324.
 *  2. Non-production build → mock sender. Tests and dev can never reach
 *     real SES by accident.
 *  3. Production build → real AWS SES via `SESv2Client`.
 *
 * Rationale: on 2026-04-11 a local test run delivered a real "Scheduled
 * Price Notification" email to a real inbox via prod credentials from
 * `.env.local`. Do not add an ALLOW_REAL_EMAIL escape hatch — if you
 * need to see a rendered email, point `EMAIL_SMTP_HOST` at Mailpit.
 */
export function createEmailSender(): EmailSender {
	const fromEmail = requireEnv("EMAIL_FROM");
	const defaultReplyTo = readEnv("EMAIL_REPLY_TO");
	const smtpHost = readEnv("EMAIL_SMTP_HOST");

	// 1. Local SMTP (Mailpit) branch. Used by dev + live email tests.
	if (smtpHost) {
		return createSmtpSender({ host: smtpHost, fromEmail, defaultReplyTo });
	}

	// 2. Hard gate: no real SES outside production builds, ever. Tests and
	// `astro dev` receive a no-op mock so they can never burn SES credits
	// or deliver to real mailboxes.
	if (!isProduction()) {
		return async () => ({
			success: true,
			messageSid: "mock",
		});
	}

	// 3. Production: real SES via the default credential chain (Lambda execution role).
	// maxAttempts: 1 — retries are delegated to withDeliveryRetry so they aren't multiplied.
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

/** Build the plaintext + HTML email body for a scheduled asset update. */
export function formatEmailMessage(
	user: EmailUser,
	userAssets: UserAssetRow[],
	assetsList: string,
	priceMap: AssetPriceMap,
	marketSession: MarketSession,
	context?: EmailFormatContext,
	/** Optional delay banners for late notifications. */
	delayBanners?: {
		text?: string | null;
		html?: string | null;
	},
	/** Session-aware first body line metadata (pre/regular/after/closed). */
	sessionFirstLine?: {
		scheduledEtMinutes: number;
		is24: boolean;
	},
	/** Symbols Massive recognized with no live trade in this session — render as
	 *  "no pre-market trades" / "no after-hours trades" instead of "price unavailable". */
	noSessionTrade?: Set<string>,
): { text: string; html: string } {
	const { getSparkline, marketClosureInfo, getLogoHtml } = context ?? {};
	const marketOpen = marketSession !== "closed";
	const urls = buildEmailUrls(user.id, user.email, "marketNotifications");
	const textFooter = `\n\nManage your delivery schedule: ${urls.scheduleUrl}\nUnsubscribe from all emails: ${urls.unsubscribeUrl}`;
	const htmlFooter = `
		<p style="color: #6b7280; font-size: 12px; margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb;">
			<a href="${urls.escapedScheduleUrl}" style="color: #667eea; text-decoration: none;">Adjust delivery schedule</a>
			<span style="color: #d1d5db; padding: 0 8px;">•</span>
			<a href="${urls.escapedUnsubscribeUrl}" style="color: #6b7280; text-decoration: none;">Unsubscribe from all emails</a>
		</p>`;

	if (userAssets.length === 0) {
		const text = `You don't have any tracked assets yet.\n\nVisit your dashboard to add assets to track: ${urls.dashboardUrl}${textFooter}`;
		const html = `
<!DOCTYPE html>
<html>
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
	<div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 8px 8px 0 0; text-align: center;">
		<h1 style="color: white; margin: 0; font-size: 28px; font-weight: 600;">Scheduled Price Update</h1>
	</div>
	<div style="background: #ffffff; padding: 40px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
		<h2 style="color: #1f2937; margin-top: 0; font-size: 24px; font-weight: 600;">Get Started Tracking Assets</h2>
		<p style="color: #4b5563; font-size: 16px; margin-bottom: 30px;">
			You don't have any tracked assets yet. Start tracking your favorite assets to receive regular updates!
		</p>
		<div style="text-align: center; margin: 40px 0;">
			<a href="${urls.escapedDashboardUrl}" style="display: inline-block; background: #667eea; color: white; text-decoration: none; padding: 14px 32px; border-radius: 6px; font-weight: 600; font-size: 16px; transition: background 0.2s;">
				Add Assets to Track →
			</a>
		</div>
		<p style="color: #6b7280; font-size: 14px; margin-top: 30px; padding-top: 30px; border-top: 1px solid #e5e7eb;">
			Once you add assets to your dashboard, you'll receive regular updates about them during your configured notification window.
		</p>
		${htmlFooter}
	</div>
</body>
</html>`;
		return { text, html };
	}

	const delayText = delayBanners?.text ? `\n${delayBanners.text}\n` : "";
	const marketDisclaimer = marketOpen
		? ""
		: `\n${buildMarketClosedBannerText(marketClosureInfo ?? null)}\n`;
	// Session-first-line is only rendered for active sessions. `marketOpen`
	// narrows `marketSession` to ActiveMarketSession (excludes "closed").
	const sessionFirstLineText =
		sessionFirstLine && marketOpen
			? `${buildSessionFirstLine(
					marketSession,
					sessionFirstLine.scheduledEtMinutes,
					sessionFirstLine.is24,
				)}\n\n`
			: "";
	const sessionFirstLineHtml =
		sessionFirstLine && marketOpen
			? buildSessionFirstLineHtml(
					marketSession,
					sessionFirstLine.scheduledEtMinutes,
					sessionFirstLine.is24,
				)
			: "";

	const text = `${sessionFirstLineText}Your tracked assets:\n${delayText}${marketDisclaimer}${assetsList}${textFooter}`;
	const getPriceForHtml = (symbol: string) =>
		noSessionTrade?.has(symbol) ? NO_SESSION_TRADE : (priceMap.get(symbol) ?? undefined);
	const escapedAssetsListHtml = formatAssetsHtmlList(userAssets, getPriceForHtml, {
		getSparkline,
		getLogoHtml,
		showChangePercent: marketSession !== "closed",
		marketSession: marketOpen ? marketSession : undefined,
	});
	const marketClosedBannerHtml = marketOpen
		? ""
		: buildMarketClosedBannerHtml(marketClosureInfo ?? null);
	const html = `
<!DOCTYPE html>
<html>
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
	<div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 8px 8px 0 0; text-align: center;">
		<h1 style="color: white; margin: 0; font-size: 28px; font-weight: 600;">Scheduled Price Update</h1>
	</div>
	<div style="background: #ffffff; padding: 40px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
		${sessionFirstLineHtml}
		${delayBanners?.html || ""}
		${marketClosedBannerHtml}
		<h2 style="color: #1f2937; margin-top: 0; font-size: 24px; font-weight: 600;">Your Scheduled Price Notification</h2>
		<div style="background: #f9fafb; padding: 20px; border-radius: 6px; margin-bottom: 30px; color: #1f2937; font-size: 14px;">
			${escapedAssetsListHtml}
		</div>
		<div style="text-align: center; margin-top: 30px;">
			<a href="${urls.escapedDashboardUrl}" style="color: #667eea; text-decoration: none; font-size: 14px; font-weight: 500;">
				Manage your notifications →
			</a>
		</div>
		${htmlFooter}
	</div>
</body>
</html>`;

	return { text, html };
}
