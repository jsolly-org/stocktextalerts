import { randomInt } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mintLinkToken } from "../../../src/lib/auth/deep-link-token";
import { POST } from "../../../src/pages/api/messaging/telegram";
import { createApiContext } from "../../helpers/api-context";
import { adminClient } from "../../helpers/test-env";
import { createTestUser } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

const WEBHOOK_SECRET = "test-telegram-webhook-secret"; // mirrors tests/setup.ts stub
const SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";

/** Allocate a unique-ish synthetic Telegram update_id / chat / user id. */
function uniqueId(): number {
	return randomInt(1, 2_000_000_000);
}

/**
 * Persist a linking-token row for `userId` and return the deep-link token. This
 * mirrors what POST /api/telegram/link does, so the webhook test exercises the
 * real verify -> atomic-consume path.
 */
async function seedLinkToken(userId: string, ttlMs = 10 * 60 * 1000): Promise<string> {
	const { token, nonce, expiresAtMs } = mintLinkToken({ userId, ttlMs });
	const { error } = await adminClient.from("telegram_link_tokens").insert({
		nonce,
		user_id: userId,
		expires_at: new Date(expiresAtMs).toISOString(),
		consumed_at: null,
	});
	if (error) throw new Error(`seedLinkToken failed: ${error.message}`);
	return token;
}

type StartUpdateOptions = {
	updateId: number;
	token?: string | null;
	chatId: number;
	fromId: number;
};

function buildStartUpdate(options: StartUpdateOptions): Record<string, unknown> {
	const text = options.token ? `/start ${options.token}` : "/start";
	return {
		update_id: options.updateId,
		message: {
			message_id: 1,
			date: Math.floor(Date.now() / 1000),
			text,
			chat: { id: options.chatId, type: "private" },
			from: { id: options.fromId, is_bot: false, first_name: "Sarah" },
		},
	};
}

function buildWebhookRequest(update: unknown, secret: string | null): Request {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (secret !== null) {
		headers[SECRET_HEADER] = secret;
	}
	return new Request("http://localhost/api/messaging/telegram", {
		method: "POST",
		headers,
		body: JSON.stringify(update),
	});
}

async function getTelegramFields(userId: string) {
	const { data, error } = await adminClient
		.from("users")
		.select("telegram_chat_id,telegram_id,telegram_linked_at,telegram_opted_out")
		.eq("id", userId)
		.single();
	if (error) throw new Error(error.message);
	if (!data) throw new Error("expected user row");
	return data;
}

describe("The Telegram bot webhook links accounts and resists abuse.", () => {
	it("A valid /start <token> links the chat to the token's user and confirms.", async () => {
		const user = await createTestUser({ confirmed: true });
		registerTestUserForCleanup(user.id);

		const token = await seedLinkToken(user.id);
		const chatId = uniqueId();
		const fromId = uniqueId();

		const response = await POST(
			createApiContext({
				request: buildWebhookRequest(
					buildStartUpdate({ updateId: uniqueId(), token, chatId, fromId }),
					WEBHOOK_SECRET,
				),
			}),
		);

		expect(response.status).toBe(200);

		const fields = await getTelegramFields(user.id);
		expect(fields.telegram_chat_id).toBe(chatId);
		expect(fields.telegram_id).toBe(fromId);
		expect(fields.telegram_linked_at).not.toBeNull();
		expect(fields.telegram_opted_out).toBe(false);
	});

	it("A missing secret header is rejected with 401 and mutates nothing.", async () => {
		const user = await createTestUser({ confirmed: true });
		registerTestUserForCleanup(user.id);

		const token = await seedLinkToken(user.id);
		const chatId = uniqueId();

		const response = await POST(
			createApiContext({
				request: buildWebhookRequest(
					buildStartUpdate({ updateId: uniqueId(), token, chatId, fromId: uniqueId() }),
					null,
				),
			}),
		);

		expect(response.status).toBe(401);

		// No link, and the token row remains unconsumed.
		const fields = await getTelegramFields(user.id);
		expect(fields.telegram_chat_id).toBeNull();
		expect(fields.telegram_id).toBeNull();
		expect(fields.telegram_linked_at).toBeNull();

		const verifiedNonce = (await import("../../../src/lib/auth/deep-link-token")).verifyLinkToken(
			token,
		)?.nonce;
		const { data: row } = await adminClient
			.from("telegram_link_tokens")
			.select("consumed_at")
			.eq("nonce", verifiedNonce as string)
			.single();
		expect(row?.consumed_at).toBeNull();
	});

	it("A wrong secret header is rejected with 401 and mutates nothing.", async () => {
		const user = await createTestUser({ confirmed: true });
		registerTestUserForCleanup(user.id);

		const token = await seedLinkToken(user.id);

		const response = await POST(
			createApiContext({
				request: buildWebhookRequest(
					buildStartUpdate({ updateId: uniqueId(), token, chatId: uniqueId(), fromId: uniqueId() }),
					"definitely-not-the-secret",
				),
			}),
		);

		expect(response.status).toBe(401);

		const fields = await getTelegramFields(user.id);
		expect(fields.telegram_chat_id).toBeNull();
		expect(fields.telegram_linked_at).toBeNull();
	});

	it("A replayed update_id is a no-op: the second delivery does not re-process.", async () => {
		const user = await createTestUser({ confirmed: true });
		registerTestUserForCleanup(user.id);

		const token = await seedLinkToken(user.id);
		const updateId = uniqueId();
		const chatId = uniqueId();
		const fromId = uniqueId();

		// First delivery links the account.
		const first = await POST(
			createApiContext({
				request: buildWebhookRequest(
					buildStartUpdate({ updateId, token, chatId, fromId }),
					WEBHOOK_SECRET,
				),
			}),
		);
		expect(first.status).toBe(200);
		const afterFirst = await getTelegramFields(user.id);
		expect(afterFirst.telegram_chat_id).toBe(chatId);

		// Re-deliver the SAME update_id but with a different chat. Because the
		// update is deduped before processing, the link must NOT change.
		const replayChatId = uniqueId();
		const second = await POST(
			createApiContext({
				request: buildWebhookRequest(
					buildStartUpdate({ updateId, token, chatId: replayChatId, fromId: uniqueId() }),
					WEBHOOK_SECRET,
				),
			}),
		);
		expect(second.status).toBe(200);

		const afterSecond = await getTelegramFields(user.id);
		expect(afterSecond.telegram_chat_id).toBe(chatId);
		expect(afterSecond.telegram_chat_id).not.toBe(replayChatId);
	});

	it("An expired token does not link the account (atomic consume rejects it).", async () => {
		const user = await createTestUser({ confirmed: true });
		registerTestUserForCleanup(user.id);

		// TTL in the past -> expires_at <= now() at consume time.
		const token = await seedLinkToken(user.id, -60_000);

		const response = await POST(
			createApiContext({
				request: buildWebhookRequest(
					buildStartUpdate({ updateId: uniqueId(), token, chatId: uniqueId(), fromId: uniqueId() }),
					WEBHOOK_SECRET,
				),
			}),
		);

		// 2XX (so Telegram doesn't retry) but the account is NOT linked.
		expect(response.status).toBe(200);
		const fields = await getTelegramFields(user.id);
		expect(fields.telegram_chat_id).toBeNull();
		expect(fields.telegram_linked_at).toBeNull();
	});

	it("A token already consumed by a prior /start cannot link a second chat.", async () => {
		const user = await createTestUser({ confirmed: true });
		registerTestUserForCleanup(user.id);

		const token = await seedLinkToken(user.id);
		const firstChat = uniqueId();

		const first = await POST(
			createApiContext({
				request: buildWebhookRequest(
					buildStartUpdate({ updateId: uniqueId(), token, chatId: firstChat, fromId: uniqueId() }),
					WEBHOOK_SECRET,
				),
			}),
		);
		expect(first.status).toBe(200);
		expect((await getTelegramFields(user.id)).telegram_chat_id).toBe(firstChat);

		// Same token, NEW update_id (so dedupe doesn't short-circuit), different chat.
		// The single-use consume must reject the second attempt.
		const secondChat = uniqueId();
		const second = await POST(
			createApiContext({
				request: buildWebhookRequest(
					buildStartUpdate({ updateId: uniqueId(), token, chatId: secondChat, fromId: uniqueId() }),
					WEBHOOK_SECRET,
				),
			}),
		);
		expect(second.status).toBe(200);

		const fields = await getTelegramFields(user.id);
		expect(fields.telegram_chat_id).toBe(firstChat);
		expect(fields.telegram_chat_id).not.toBe(secondChat);
	});
});
