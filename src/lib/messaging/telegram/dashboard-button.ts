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
 * The `#section` hash is client-side only — a signed-out tap lands on signin and then
 * the /dashboard root (the section anchor is lost across the auth redirect). This is the
 * same accepted limitation as the email section deep-links.
 */
export function buildDashboardButton(section: DashboardSection): InlineKeyboardMarkup {
	const url = `${new URL("/dashboard", getSiteUrl())}${DASHBOARD_SECTION_HASHES[section]}`;
	return { inline_keyboard: [[{ text: "⚙️ Manage notifications", url }]] };
}
