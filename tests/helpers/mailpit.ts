/**
 * Mailpit (Supabase's bundled Inbucket container) helpers for tests that
 * need to assert against a rendered email. The container's HTTP API is
 * reachable at http://localhost:54324 whenever local Supabase is running.
 *
 * Mailpit is the only approved destination for test email delivery —
 * tests never hit real SES. See `AGENTS.md#testing-philosophy`. Routing
 * to Mailpit is unlocked by setting `EMAIL_SMTP_HOST=localhost` in the
 * test environment; `tests/run-vitest.ts` sets it automatically when
 * `--live=email` is passed. `src/lib/messaging/email/utils.ts` picks up
 * the env var and returns a nodemailer-backed sender instead of SES.
 */

const MAILPIT_BASE = "http://localhost:54324";

/** Minimal Mailpit `/api/v1/messages` list-row shape. */
type MailpitRecipient = { Address?: string };
type MailpitListRow = {
	ID: string;
	Subject?: string;
	To?: MailpitRecipient[];
};
type MailpitListResponse = { messages?: MailpitListRow[]; total?: number };

/** Minimal Mailpit `/api/v1/message/{id}` detail shape. */
type MailpitMessageResponse = {
	ID?: string;
	Subject?: string;
	Text?: string;
	HTML?: string;
	To?: MailpitRecipient[];
};

type MailpitMessage = {
	id: string;
	subject: string;
	to: string[];
	text: string;
	html: string;
};

/** List all messages currently in Mailpit. */
async function listMailpitMessages(): Promise<MailpitListRow[]> {
	const response = await fetch(`${MAILPIT_BASE}/api/v1/messages`);
	if (!response.ok) {
		throw new Error(`Mailpit list failed: ${response.status} ${await response.text()}`);
	}
	const payload = (await response.json()) as MailpitListResponse;
	return payload.messages ?? [];
}

/** Fetch a single rendered message by ID. */
async function getMailpitMessage(id: string): Promise<MailpitMessage> {
	const response = await fetch(`${MAILPIT_BASE}/api/v1/message/${encodeURIComponent(id)}`);
	if (!response.ok) {
		throw new Error(`Mailpit fetch failed: ${response.status} ${await response.text()}`);
	}
	const payload = (await response.json()) as MailpitMessageResponse;
	return {
		id,
		subject: payload.Subject ?? "",
		to: (payload.To ?? [])
			.map((recipient) => recipient.Address ?? "")
			.filter((addr): addr is string => addr.length > 0),
		text: payload.Text ?? "",
		html: payload.HTML ?? "",
	};
}

/** Delete every message in Mailpit. Call in beforeEach. */
export async function clearMailpit(): Promise<void> {
	const response = await fetch(`${MAILPIT_BASE}/api/v1/messages`, {
		method: "DELETE",
	});
	if (!response.ok) {
		throw new Error(`Mailpit clear failed: ${response.status} ${await response.text()}`);
	}
}

type WaitOptions = {
	timeoutMs?: number;
	pollIntervalMs?: number;
};

/**
 * Poll Mailpit until a message matching `predicate` appears, then fetch
 * and return its full body. Throws if no match within `timeoutMs`.
 *
 * Transient errors from Mailpit (503 during startup, socket hiccups) are
 * swallowed and retried on the next poll so a test doesn't die on the
 * first unlucky request. The timeout still bounds total wall time; the
 * last error is included in the timeout message for debuggability.
 */
async function waitForMailpitMessage(
	predicate: (row: MailpitListRow) => boolean,
	options: WaitOptions = {},
): Promise<MailpitMessage> {
	const timeoutMs = options.timeoutMs ?? 15_000;
	const pollIntervalMs = options.pollIntervalMs ?? 250;
	const startedAt = Date.now();
	let lastError: unknown;
	while (Date.now() - startedAt < timeoutMs) {
		try {
			const rows = await listMailpitMessages();
			const match = rows.find(predicate);
			if (match) {
				return getMailpitMessage(match.ID);
			}
		} catch (error) {
			lastError = error;
		}
		await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
	}
	const suffix = lastError
		? ` Last Mailpit error: ${lastError instanceof Error ? lastError.message : String(lastError)}`
		: "";
	throw new Error(
		`Timed out after ${timeoutMs}ms waiting for a matching Mailpit message.${suffix}`,
	);
}

/** Convenience: wait for a message addressed to `recipient`. */
export async function waitForMailpitMessageTo(
	recipient: string,
	options?: WaitOptions,
): Promise<MailpitMessage> {
	const target = recipient.toLowerCase();
	return waitForMailpitMessage(
		(row) => (row.To ?? []).some((to) => (to.Address ?? "").toLowerCase() === target),
		options,
	);
}
