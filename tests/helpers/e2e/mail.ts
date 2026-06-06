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
