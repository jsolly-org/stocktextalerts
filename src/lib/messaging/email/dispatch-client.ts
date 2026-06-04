import { readEnv } from "../../db/env";
import type { Logger } from "../../logging";
import { isProduction } from "../../runtime/mode";
import type { DeliveryResult } from "../types";
import { signEmailDispatchBody } from "./dispatch-auth";
import {
	EMAIL_DISPATCH_SIGNATURE_HEADER,
	EMAIL_DISPATCH_TIMESTAMP_HEADER,
	type EmailDispatchResponse,
} from "./dispatch-contract";
import { createEmailSender, type EmailRequest } from "./utils";

function isEmailDispatchResponse(value: unknown): value is EmailDispatchResponse {
	if (typeof value !== "object" || value === null) return false;
	const response = value as Partial<EmailDispatchResponse>;
	if (response.success === true) return true;
	return response.success === false && typeof response.error === "string";
}

export async function sendAppTransactionalEmail(
	request: EmailRequest,
	logger: Logger,
): Promise<DeliveryResult> {
	const dispatchUrl = readEnv("EMAIL_DISPATCH_URL");
	const dispatchSecret = readEnv("EMAIL_DISPATCH_SECRET");

	if (!dispatchUrl || !dispatchSecret) {
		if (!isProduction()) {
			return createEmailSender()(request);
		}
		const missing = [
			...(dispatchUrl ? [] : ["EMAIL_DISPATCH_URL"]),
			...(dispatchSecret ? [] : ["EMAIL_DISPATCH_SECRET"]),
		];
		logger.error("Email dispatch is not configured", { missing });
		return {
			success: false,
			error: `Missing email dispatch configuration: ${missing.join(", ")}`,
			errorCode: "email_dispatch_not_configured",
		};
	}

	const body = JSON.stringify(request);
	const timestamp = Date.now().toString();
	const signature = signEmailDispatchBody(body, timestamp, dispatchSecret);

	try {
		const response = await fetch(dispatchUrl, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				[EMAIL_DISPATCH_SIGNATURE_HEADER]: signature,
				[EMAIL_DISPATCH_TIMESTAMP_HEADER]: timestamp,
			},
			body,
		});
		if (!response.ok) {
			const error = await response.text();
			logger.error("Email dispatch request failed", {
				status: response.status,
				error,
				userId: request.userId,
			});
			return {
				success: false,
				error,
				errorCode: `email_dispatch_http_${response.status}`,
			};
		}

		const payload: unknown = await response.json();
		if (!isEmailDispatchResponse(payload)) {
			logger.error("Email dispatch returned invalid response", { userId: request.userId });
			return {
				success: false,
				error: "Invalid email dispatch response",
				errorCode: "email_dispatch_invalid_response",
			};
		}
		return payload;
	} catch (error) {
		logger.error("Email dispatch request threw", { userId: request.userId }, error);
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
			errorCode: error instanceof Error ? error.name : "email_dispatch_error",
		};
	}
}
