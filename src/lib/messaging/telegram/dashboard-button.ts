import type { InlineKeyboardMarkup } from "grammy/types";
import { DASHBOARD_SECTION_HASHES } from "../../constants";
import { getSiteUrl } from "../../db/env";

/** A dashboard section the "Manage notifications" button can deep-link to. */
export type DashboardSection = keyof typeof DASHBOARD_SECTION_HASHES;

/**
 * Build the "⚙️ Manage notifications" inline-keyboard button deep-linked to a
 * dashboard section, so a Telegram notification carries the same reach-your-dashboard
 * affordance the email already does (via its footer links).
 *
 * The `#section` hash is browser-only (servers never see it). Signed-out taps hit
 * `/auth/signin?redirect=/dashboard` and the sign-in page folds the preserved
 * location hash into the post-auth redirect so the section deep link survives.
 */
export function buildDashboardButton(section: DashboardSection): InlineKeyboardMarkup {
	const url = `${new URL("/dashboard", getSiteUrl())}${DASHBOARD_SECTION_HASHES[section]}`;
	return { inline_keyboard: [[{ text: "⚙️ Manage notifications", url }]] };
}
