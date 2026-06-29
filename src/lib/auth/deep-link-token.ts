import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { requireEnv } from "../db/env";

/**
 * Telegram deep-link linking tokens.
 *
 * A token is a single base64url blob carried in a `t.me/<bot>?start=<token>`
 * deep link. Telegram caps the `/start` payload at 64 characters and only
 * allows `[A-Za-z0-9_-]`, so the token must fit `^[A-Za-z0-9_-]{1,64}$`.
 *
 * Sizing: a full UUID payload (`{u,e,n}` JSON + HMAC, base64url) is ~158 chars —
 * far over the limit. So the token carries ONLY a random nonce plus a truncated
 * HMAC over that nonce; the `{nonce -> user_id, expires_at}` binding lives
 * server-side in `telegram_link_tokens` (inserted by the link endpoint, consumed
 * by the webhook). The token therefore decodes to a 40-char blob:
 *
 *   base64url( nonce(12 bytes) || HMAC-SHA256(nonce, secret)[:18] )  -> 40 chars
 *
 * Security model:
 * - The userId is the SIGNED SUBJECT: it is bound to the nonce server-side at
 *   mint time, and the webhook links via the DB row's `user_id` — never via the
 *   Telegram `from.id`. The HMAC proves WE minted this nonce; an attacker cannot
 *   forge a `/start` payload that resolves to a real linking row.
 * - Verification is a constant-time signature check (`timingSafeEqual`). Expiry
 *   and single-use are enforced by the atomic conditional consume on the DB row,
 *   not here — `verifyLinkToken` only authenticates the nonce.
 */

/** Random nonce length in bytes (16 base64url chars after encoding). */
const NONCE_BYTES = 12;
/** Truncated-HMAC length in bytes (128+ bits of forgery resistance). */
const SIG_BYTES = 18;
/** Decoded blob = nonce || truncated-sig. */
const TOKEN_BYTES = NONCE_BYTES + SIG_BYTES;
/** Telegram `/start` payload character class + length cap. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function linkTokenSecret(): string {
	return requireEnv("TELEGRAM_LINK_TOKEN_SECRET");
}

/** HMAC-SHA256 over the raw nonce bytes, truncated to `SIG_BYTES`. */
function signNonce(nonce: Buffer, secret: string): Buffer {
	return createHmac("sha256", secret).update(nonce).digest().subarray(0, SIG_BYTES);
}

export type MintLinkTokenOptions = {
	/** The account being linked — the signed subject, persisted server-side. */
	userId: string;
	/** Token lifetime in milliseconds (e.g. 10 minutes). */
	ttlMs: number;
	/** Optional clock override for determinism. */
	now?: number;
};

export type MintedLinkToken = {
	/** The base64url `/start` payload (matches `^[A-Za-z0-9_-]{1,64}$`). */
	token: string;
	/** The nonce — primary key of the `telegram_link_tokens` row to insert. */
	nonce: string;
	/** Absolute expiry (ms epoch) to store in `telegram_link_tokens.expires_at`. */
	expiresAtMs: number;
};

/**
 * Mint a signed linking token for `userId`.
 *
 * Returns the deep-link `token`, the `nonce` (DB primary key) and `expiresAtMs`.
 * The caller MUST insert `{ nonce, user_id: userId, expires_at: expiresAtMs }`
 * into `telegram_link_tokens` so the webhook can resolve the nonce back to the
 * signed subject.
 */
export function mintLinkToken(options: MintLinkTokenOptions): MintedLinkToken {
	// `userId` is the signed subject, but it is bound to the nonce server-side by
	// the caller (the `telegram_link_tokens` row), not embedded in the token — a
	// full UUID payload would blow past Telegram's 64-char `/start` limit.
	const { ttlMs, now = Date.now() } = options;
	const nonceBuffer = randomBytes(NONCE_BYTES);
	const signature = signNonce(nonceBuffer, linkTokenSecret());
	const token = Buffer.concat([nonceBuffer, signature]).toString("base64url");
	// Defensive: the shape is fixed (40 chars), but assert the contract so a
	// future tweak to NONCE_BYTES/SIG_BYTES can never silently emit an illegal
	// `/start` payload.
	if (!TOKEN_PATTERN.test(token)) {
		throw new Error("mintLinkToken produced a token that is not a valid Telegram /start payload");
	}
	return {
		token,
		nonce: nonceBuffer.toString("base64url"),
		expiresAtMs: now + ttlMs,
	};
}

/**
 * Verify a `/start` token's signature in constant time and return its nonce.
 *
 * Returns `null` for any malformed or unsigned/forged token. A non-null nonce
 * means the token was minted by us; the caller still MUST atomically consume the
 * matching `telegram_link_tokens` row (which enforces expiry + single-use) and
 * link via that row's `user_id`.
 */
export function verifyLinkToken(token: string): { nonce: string } | null {
	if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) {
		return null;
	}

	let decoded: Buffer;
	try {
		decoded = Buffer.from(token, "base64url");
	} catch {
		return null;
	}
	if (decoded.length !== TOKEN_BYTES) {
		return null;
	}

	const nonceBuffer = decoded.subarray(0, NONCE_BYTES);
	const presentedSig = decoded.subarray(NONCE_BYTES);
	const expectedSig = signNonce(nonceBuffer, linkTokenSecret());
	if (presentedSig.length !== expectedSig.length) {
		return null;
	}
	if (!timingSafeEqual(presentedSig, expectedSig)) {
		return null;
	}

	return { nonce: nonceBuffer.toString("base64url") };
}
