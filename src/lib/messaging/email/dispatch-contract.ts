export type EmailDispatchRequest = {
	to: string;
	subject: string;
	body: string;
	html?: string;
	idempotencyKey?: string;
	userId?: string;
};

export type EmailDispatchResponse =
	| { success: true; messageSid?: string }
	| { success: false; error: string; errorCode?: string };

export const EMAIL_DISPATCH_SIGNATURE_HEADER = "x-stocktextalerts-email-signature";
export const EMAIL_DISPATCH_TIMESTAMP_HEADER = "x-stocktextalerts-email-timestamp";
export const EMAIL_DISPATCH_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;
