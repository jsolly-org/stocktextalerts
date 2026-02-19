import { createHmac, timingSafeEqual } from "node:crypto";
import { getSiteUrl } from "../../db/env";

const DEFAULT_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30;

/**
 * Read CRON_SECRET from the environment for use in signing unsubscribe tokens.
 * Returns null when the secret is missing or not a non-empty string.
 */
function getUnsubscribeSecret(): string | null {
	const secret = import.meta.env.CRON_SECRET;
	return typeof secret === "string" && secret.trim().length > 0 ? secret : null;
}

/** Encode a buffer to base64url (URL-safe, no padding). */
function toBase64Url(buffer: Buffer): string {
	return buffer
		.toString("base64")
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/u, "");
}

/** Decode a base64url string back to a Buffer. */
function fromBase64Url(value: string): Buffer {
	const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
	const padding = normalized.length % 4;
	const padded =
		padding === 0 ? normalized : normalized + "=".repeat(4 - padding);
	return Buffer.from(padded, "base64");
}

/**
 * Create a signed unsubscribe token for a specific user+email pair.
 *
 * The token embeds an expiry timestamp and an HMAC signature using `CRON_SECRET`.
 */
export function createEmailUnsubscribeToken(options: {
	userId: string;
	email: string;
	expiresAtMs?: number;
}): string {
	const expiresAtMs = options.expiresAtMs ?? Date.now() + DEFAULT_TOKEN_TTL_MS;
	const secret = getUnsubscribeSecret();
	if (!secret) {
		throw new Error("CRON_SECRET is required for email unsubscribe tokens");
	}
	const payload = `${options.userId}.${options.email}.${expiresAtMs}`;
	const signature = createHmac("sha256", secret).update(payload).digest();
	return `${expiresAtMs}.${toBase64Url(signature)}`;
}

/**
 * Verify a previously issued unsubscribe token for a given user+email pair.
 *
 * Returns `{ ok: true }` on success, otherwise `{ ok: false, reason }`.
 */
export function verifyEmailUnsubscribeToken(options: {
	userId: string;
	email: string;
	token: string;
}): { ok: true } | { ok: false; reason: string } {
	const [rawExpires, rawSignature] = options.token.split(".");
	if (!rawExpires || !rawSignature) {
		return { ok: false, reason: "invalid_token" };
	}

	const expiresAtMs = Number(rawExpires);
	if (!Number.isFinite(expiresAtMs)) {
		return { ok: false, reason: "invalid_token" };
	}
	if (expiresAtMs < Date.now()) {
		return { ok: false, reason: "expired_token" };
	}

	const secret = getUnsubscribeSecret();
	if (!secret) {
		return { ok: false, reason: "invalid_token" };
	}
	const payload = `${options.userId}.${options.email}.${expiresAtMs}`;
	const expected = createHmac("sha256", secret).update(payload).digest();
	const provided = fromBase64Url(rawSignature);
	if (provided.length !== expected.length) {
		return { ok: false, reason: "invalid_token" };
	}

	if (!timingSafeEqual(expected, provided)) {
		return { ok: false, reason: "invalid_token" };
	}

	return { ok: true };
}

/**
 * Create a fully-qualified unsubscribe URL that includes a signed token.
 */
export function createEmailUnsubscribeUrl(options: {
	userId: string;
	email: string;
}): string {
	const token = createEmailUnsubscribeToken(options);
	const baseUrl = `${getSiteUrl()}/email/unsubscribe`;
	const params = new URLSearchParams({
		user: options.userId,
		token,
	});
	return `${baseUrl}?${params.toString()}`;
}
