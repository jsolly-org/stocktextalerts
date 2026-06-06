import type { Page } from "@playwright/test";
import { waitForMailpitMessageWithSubject } from "../mailpit";

type E2eEmailMessage = {
	subject?: string;
	body: {
		text?: string;
		html?: string;
	};
};

export function extractLinks(message: E2eEmailMessage | string): string[] {
	const raw =
		typeof message === "string"
			? message
			: `${message.body.html ?? ""}\n${message.body.text ?? ""}`;
	const matches = raw.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
	return [...new Set(matches.map((match) => match.replaceAll("&amp;", "&")))];
}

export function rewriteLinkOrigin(link: string, baseOrigin: string): string {
	const rewritten = new URL(link);
	const base = new URL(baseOrigin);
	rewritten.protocol = base.protocol;
	rewritten.host = base.host;
	return rewritten.toString();
}

function extractTokenHashFromLink(link: string): string | null {
	try {
		const url = new URL(link);
		return url.searchParams.get("token_hash") ?? url.searchParams.get("token");
	} catch {
		return null;
	}
}

/** Deduplicate email-change links by token hash (old/new inboxes may repeat URLs). */
export function uniqueEmailChangeLinksByToken(links: string[]): string[] {
	const seen = new Set<string>();
	const unique: string[] = [];
	for (const link of links) {
		const tokenHash = extractTokenHashFromLink(link);
		const key = tokenHash ?? link;
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(link);
	}
	return unique;
}

/**
 * Confirm each distinct email-change inbox link once. Skips links whose verify
 * button is absent (already consumed) and never re-submits the same token hash.
 */
export async function confirmEmailChangeLinks(
	page: Page,
	links: string[],
	baseOrigin: string,
): Promise<void> {
	const clickedTokens = new Set<string>();

	for (const link of uniqueEmailChangeLinksByToken(links)) {
		const tokenHash = extractTokenHashFromLink(link);
		if (tokenHash && clickedTokens.has(tokenHash)) {
			continue;
		}

		await page.goto(rewriteLinkOrigin(link, baseOrigin));
		const verifyButton = page.getByRole("button", { name: "Verify my email" });
		if (!(await verifyButton.isVisible({ timeout: 5_000 }).catch(() => false))) {
			continue;
		}

		await verifyButton.click();
		if (tokenHash) {
			clickedTokens.add(tokenHash);
		}
	}
}

function toE2eMessage(mailpitMessage: {
	subject: string;
	text: string;
	html: string;
}): E2eEmailMessage {
	return {
		subject: mailpitMessage.subject,
		body: {
			text: mailpitMessage.text,
			html: mailpitMessage.html,
		},
	};
}

export async function waitForEmail(
	email: string,
	subjectContains: string,
	timeoutMs = 30_000,
): Promise<E2eEmailMessage> {
	const message = await waitForMailpitMessageWithSubject(email, subjectContains, {
		timeoutMs,
	});
	return toE2eMessage(message);
}

export async function maybeWaitForEmail(
	email: string,
	subjectContains: string,
	timeoutMs = 30_000,
): Promise<E2eEmailMessage | null> {
	try {
		return await waitForEmail(email, subjectContains, timeoutMs);
	} catch {
		return null;
	}
}
