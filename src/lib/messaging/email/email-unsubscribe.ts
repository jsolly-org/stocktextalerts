import { createHmac, timingSafeEqual } from "node:crypto";
import { getSiteUrl } from "../../db/env";

const DEFAULT_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30;

function toBase64Url(buffer: Buffer): string {
	return buffer
		.toString("base64")
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/u, "");
}

function fromBase64Url(value: string): Buffer {
	const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
	const padding = normalized.length % 4;
	const padded =
		padding === 0 ? normalized : normalized + "=".repeat(4 - padding);
	return Buffer.from(padded, "base64");
}

export function createEmailUnsubscribeToken(options: {
	userId: string;
	email: string;
	expiresAtMs?: number;
}): string {
	const expiresAtMs = options.expiresAtMs ?? Date.now() + DEFAULT_TOKEN_TTL_MS;
	const secret = import.meta.env.CRON_SECRET;
	const payload = `${options.userId}.${options.email}.${expiresAtMs}`;
	const signature = createHmac("sha256", secret).update(payload).digest();
	return `${expiresAtMs}.${toBase64Url(signature)}`;
}

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

	const secret = import.meta.env.CRON_SECRET;
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
