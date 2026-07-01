import type { DeliveryResult } from "../../types";

export interface EmailRequest {
	to: string;
	subject: string;
	body: string;
	html?: string;
	idempotencyKey?: string;
	replyTo?: string;
	userId?: string;
}

export type EmailSender = (request: EmailRequest) => Promise<DeliveryResult>;
