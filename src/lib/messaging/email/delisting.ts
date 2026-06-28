import { NOT_FINANCIAL_ADVICE } from "../parts/footer";
import { escapeHtml } from "../parts/html-utils";
import type { EmailUser } from "../types";
import { buildEmailUrls, renderEmailFooter } from "./layout";

/** A single holding being reported as delisted in a notification email. */
export interface DelistedHolding {
	symbol: string;
	name: string;
	/** YYYY-MM-DD date the exchange marked the ticker as delisted. */
	delistedDate: string;
	/** Primary exchange label (e.g. "NASDAQ"). Optional; omitted when unknown. */
	exchange?: string | null;
}

const MAX_SUMMARY_LENGTH = 500;

/** Build a plaintext one-line summary for `notification_log.message`. */
export function summaryText(holdings: DelistedHolding[]): string {
	const pieces = holdings.map((h) => `${h.symbol} (${h.delistedDate})`);
	const full =
		holdings.length === 1
			? `Delisted: ${pieces[0]}`
			: `Delisted ${holdings.length} holdings: ${pieces.join(", ")}`;
	return full.length <= MAX_SUMMARY_LENGTH ? full : `${full.slice(0, MAX_SUMMARY_LENGTH - 1)}…`;
}

/**
 * Format a delisting notification email. Handles single- and multi-holding
 * cases with pluralized copy. Style matches `formatEmailMessage` in
 * `src/lib/messaging/email/utils.ts` — gradient header, 600px max-width,
 * inline CSS, reusing `buildEmailUrls` + `renderEmailFooter`.
 */
export function formatDelistingEmail(
	user: EmailUser,
	holdings: DelistedHolding[],
): { subject: string; text: string; html: string } {
	const first = holdings[0];
	if (!first) {
		throw new Error("formatDelistingEmail requires at least one delisted holding");
	}

	const urls = buildEmailUrls(user.id, user.email, "assets");
	const isSingle = holdings.length === 1;

	// Subject
	const subject = isSingle
		? `${first.symbol} was delisted — removed from your alerts`
		: `${holdings.length} of your tracked stocks were delisted — removed from your alerts`;

	// Plaintext
	const textLines = holdings.map((h) => {
		const exchangeLabel = h.exchange ? ` on ${h.exchange}` : "";
		return `  • ${h.symbol} (${h.name}) was delisted${exchangeLabel} on ${h.delistedDate}`;
	});
	const textIntro = isSingle
		? "One of your tracked stocks was delisted:"
		: `${holdings.length} of your tracked stocks were delisted:`;
	const itPronoun = isSingle ? "it" : "them";
	const stockNoun = isSingle ? "this symbol" : "these symbols";
	const text = `${textIntro}

${textLines.join("\n")}

Because delisted stocks no longer trade on a public exchange, we've removed ${itPronoun} from your tracked assets. You will not receive further price alerts for ${stockNoun}.

If you believe this is an error, or if ${isSingle ? "the stock" : "any of them"} has relisted under a new symbol, you can add ${itPronoun} again from your dashboard:
${urls.dashboardUrl}

Manage your delivery schedule: ${urls.scheduleUrl}
Unsubscribe from all emails: ${urls.unsubscribeUrl}
${NOT_FINANCIAL_ADVICE}
`;

	// HTML
	const holdingsHtml = holdings
		.map((h) => {
			const exchangeHtml = h.exchange
				? ` <span style="color: #6b7280;">on ${escapeHtml(h.exchange)}</span>`
				: "";
			return `
			<tr>
				<td style="padding: 12px 0; border-bottom: 1px solid #e5e7eb;">
					<div style="font-family: 'Courier New', monospace; font-weight: 600; color: #1f2937; font-size: 16px;">
						${escapeHtml(h.symbol)}
					</div>
					<div style="color: #4b5563; font-size: 14px; margin-top: 2px;">
						${escapeHtml(h.name)}
					</div>
					<div style="color: #6b7280; font-size: 13px; margin-top: 4px;">
						Delisted ${escapeHtml(h.delistedDate)}${exchangeHtml}
					</div>
				</td>
			</tr>`;
		})
		.join("");

	const headline = isSingle
		? "A tracked stock was delisted"
		: `${holdings.length} tracked stocks were delisted`;
	const explainer = isSingle
		? "Because this stock no longer trades on a public exchange, we've removed it from your tracked assets. You will not receive further price alerts for this symbol."
		: "Because these stocks no longer trade on a public exchange, we've removed them from your tracked assets. You will not receive further price alerts for these symbols.";
	const errorLine = `If you believe this is an error, or if ${isSingle ? "the stock" : "any of them"} has relisted under a new symbol, you can add ${itPronoun} again from your dashboard.`;

	const html = `
<!DOCTYPE html>
<html>
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
	<div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 8px 8px 0 0; text-align: center;">
		<h1 style="color: white; margin: 0; font-size: 26px; font-weight: 600;">${headline}</h1>
	</div>
	<div style="background: #ffffff; padding: 40px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
		<p style="color: #4b5563; font-size: 15px; margin-top: 0; margin-bottom: 20px;">
			${explainer}
		</p>
		<table style="width: 100%; border-collapse: collapse; margin-bottom: 24px;">
			${holdingsHtml}
		</table>
		<p style="color: #4b5563; font-size: 14px; margin-bottom: 24px;">
			${errorLine}
		</p>
		<div style="text-align: center; margin: 24px 0;">
			<a href="${urls.escapedDashboardUrl}" style="display: inline-block; background: #667eea; color: white; text-decoration: none; padding: 12px 28px; border-radius: 6px; font-weight: 600; font-size: 15px;">
				Open Dashboard →
			</a>
		</div>
		${renderEmailFooter(urls)}
	</div>
</body>
</html>`;

	return { subject, text, html };
}
