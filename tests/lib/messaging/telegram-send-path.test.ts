/**
 * Transformer payload tests for the real grammY send path.
 *
 * Tests install a grammY **transformer**
 * (`bot.api.config.use((prev, method, payload) => fakeResponse)`), which
 * intercepts every outgoing call and lets us assert on the (method, payload)
 * pair while returning a fabricated Bot-API response.
 *
 * Why this is network-free *and* fake-token-safe: the transformer is the
 * outermost layer of grammY's call stack, so `prev` (the real HTTP client) is
 * never invoked. Returning `{ ok: true, result }` resolves the call; returning
 * `{ ok: false, error_code, description }` makes grammY's `callApi` throw a real
 * `GrammyError` (see grammy/out/core/client.js `callApi`) — which is exactly the
 * branch `sendViaBot` maps to `{ success: false, errorCode }`. We deliberately do
 * NOT throw from the transformer: a thrown error is re-wrapped by grammY as an
 * `HttpError`, not a `GrammyError`, and would bypass the errorCode mapping.
 */
import { type Bot, InputFile, type Transformer } from "grammy";
import type { ApiResponse } from "grammy/types";
import { describe, expect, it } from "vitest";
import { createTelegramBot, sendViaBot } from "../../../src/lib/messaging/telegram/sender";

// Syntactically-valid but fake bot token. grammY's Bot constructor stores it
// without any network call; the capturing transformer below means `bot.api`
// never reaches api.telegram.org regardless of the token's validity.
const FAKE_TOKEN = "123:fake-token-for-transformer-tests-only";

interface Captured {
	method: string;
	payload: Record<string, unknown>;
}

/**
 * Cast a canned response to the generic shape grammY's transformer pipeline
 * expects. The transformer return type is `ApiResponse<ApiCallResult<M>>` keyed on
 * the (generic) method `M`, which a concrete literal can't satisfy structurally —
 * but the runtime only reads `.ok`/`.result`/`.error_code`, so the cast is sound.
 */
function asApiResponse(response: ApiResponse<unknown>): ReturnType<Transformer> {
	return Promise.resolve(response) as ReturnType<Transformer>;
}

/**
 * Build a bot whose transformer records the outgoing (method, payload) into the
 * returned `capture` ref and resolves with a successful response carrying
 * `message_id`. The ref is populated synchronously on each call.
 */
function captureSuccess(messageId: number): { bot: Bot; capture: { value: Captured | null } } {
	const bot = createTelegramBot(FAKE_TOKEN);
	const capture: { value: Captured | null } = { value: null };
	const transformer: Transformer = (_prev, method, payload) => {
		capture.value = { method, payload: payload as Record<string, unknown> };
		return asApiResponse({
			ok: true,
			result: { message_id: messageId, date: 0, chat: { id: 0, type: "private" } },
		});
	};
	bot.api.config.use(transformer);
	return { bot, capture };
}

/**
 * Build a bot whose transformer returns a Bot-API *error* response. grammY's
 * `callApi` turns this into a thrown `GrammyError` with the given `error_code`,
 * exercising `sendViaBot`'s GrammyError branch (no HttpError re-wrap, because we
 * return the response rather than throwing).
 */
function captureError(errorCode: number, description: string): Bot {
	const bot = createTelegramBot(FAKE_TOKEN);
	const transformer: Transformer = () =>
		asApiResponse({ ok: false, error_code: errorCode, description });
	bot.api.config.use(transformer);
	return bot;
}

describe("sendViaBot exercises the real grammY API construction (transformer-mocked)", () => {
	it("text-only → sendMessage with entities, disabled link preview, and disable_notification", async () => {
		const { bot, capture } = captureSuccess(42);
		const result = await sendViaBot(bot, {
			chatId: 5550001,
			text: "AAPL up 5.3%",
			entities: [{ type: "bold", offset: 0, length: 4 }],
			disableNotification: true,
		});

		expect(result).toEqual({ success: true, messageSid: "42" });

		// The capturing transformer recorded the REAL outgoing payload.
		expect(capture.value?.method).toBe("sendMessage");
		const p = capture.value?.payload as Record<string, unknown>;
		expect(p.chat_id).toBe(5550001);
		expect(p.text).toBe("AAPL up 5.3%");
		expect(p.entities).toEqual([{ type: "bold", offset: 0, length: 4 }]);
		expect(p.disable_notification).toBe(true);
		// Link previews are suppressed for our alerts.
		expect(p.link_preview_options).toEqual({ is_disabled: true });
		// No photo path was taken.
		expect(p.photo).toBeUndefined();
	});

	it("with a photo Buffer → sendPhoto carrying an InputFile, caption, and caption_entities", async () => {
		const { bot, capture } = captureSuccess(99);
		const result = await sendViaBot(bot, {
			chatId: "5550002",
			text: "LDOS chart",
			entities: [{ type: "bold", offset: 0, length: 4 }],
			photo: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
		});

		expect(result).toEqual({ success: true, messageSid: "99" });

		expect(capture.value?.method).toBe("sendPhoto");
		const p = capture.value?.payload as Record<string, unknown>;
		expect(p.chat_id).toBe("5550002");
		// The Buffer is wrapped in a grammY InputFile for multipart upload.
		expect(p.photo).toBeInstanceOf(InputFile);
		expect(p.caption).toBe("LDOS chart");
		expect(p.caption_entities).toEqual([{ type: "bold", offset: 0, length: 4 }]);
		// sendPhoto carries no `text`/`entities`/`link_preview_options` keys.
		expect(p.text).toBeUndefined();
		expect(p.link_preview_options).toBeUndefined();
	});

	it("a 403 Bot-API error response → { success: false, errorCode: '403' }", async () => {
		const bot = captureError(403, "Forbidden: bot was blocked by the user");
		const result = await sendViaBot(bot, { chatId: 5550003, text: "blocked-user alert" });

		expect(result.success).toBe(false);
		if (result.success === false) {
			expect(result.errorCode).toBe("403");
			expect(result.error).toBe("Forbidden: bot was blocked by the user");
		}
	});

	it("returns messageSid stringified from the response message_id", async () => {
		const { bot } = captureSuccess(123_456);
		const result = await sendViaBot(bot, { chatId: 5550004, text: "id check" });
		expect(result).toEqual({ success: true, messageSid: "123456" });
	});
});
