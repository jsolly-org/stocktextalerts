import { createHmac, timingSafeEqual } from "node:crypto";
import { EMAIL_DISPATCH_TIMESTAMP_TOLERANCE_MS } from "./dispatch-contract";

type VerifyEmailDispatchSignatureOptions = {
	body: string;
	timestamp: string | null | undefined;
	signature: string | null | undefined;
	secret: string;
	now?: number;
};

function signatureInput(body: string, timestamp: string): string {
	return `${timestamp}.${body}`;
}

export function signEmailDispatchBody(body: string, timestamp: string, secret: string): string {
	return createHmac("sha256", secret).update(signatureInput(body, timestamp)).digest("hex");
}

export function verifyEmailDispatchSignature(
	options: VerifyEmailDispatchSignatureOptions,
): boolean {
	const { body, timestamp, signature, secret, now = Date.now() } = options;
	if (!timestamp || !signature || !secret) return false;

	const timestampMs = Number.parseInt(timestamp, 10);
	if (!Number.isFinite(timestampMs)) return false;
	if (Math.abs(now - timestampMs) > EMAIL_DISPATCH_TIMESTAMP_TOLERANCE_MS) return false;
	if (!/^[a-f0-9]{64}$/iu.test(signature)) return false;

	const expected = signEmailDispatchBody(body, timestamp, secret);
	const expectedBuffer = Buffer.from(expected, "hex");
	const actualBuffer = Buffer.from(signature, "hex");
	if (actualBuffer.length !== expectedBuffer.length) return false;

	return timingSafeEqual(actualBuffer, expectedBuffer);
}
