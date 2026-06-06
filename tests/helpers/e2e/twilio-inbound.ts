import { createHmac, randomUUID } from "node:crypto";

function computeTwilioSignature(
	authToken: string,
	url: string,
	params: Record<string, string | undefined>,
): string {
	const sortedKeys = Object.keys(params)
		.filter((key) => params[key] != null)
		.sort();
	let data = url;
	for (const key of sortedKeys) {
		data += key + params[key];
	}
	return createHmac("sha1", authToken).update(data, "utf-8").digest("base64");
}

function buildInboundSignatureParams(
	params: Record<string, string>,
): Record<string, string | undefined> {
	const signatureParams: Record<string, string | undefined> = {
		MessageSid: undefined,
		SmsSid: undefined,
		SmsMessageSid: undefined,
		AccountSid: undefined,
		MessagingServiceSid: undefined,
		From: undefined,
		FromCity: undefined,
		FromState: undefined,
		FromZip: undefined,
		FromCountry: undefined,
		To: undefined,
		ToCity: undefined,
		ToState: undefined,
		ToZip: undefined,
		ToCountry: undefined,
		Body: undefined,
		NumSegments: undefined,
		NumMedia: undefined,
		ApiVersion: undefined,
		SmsStatus: undefined,
		ForwardedFrom: undefined,
		CallerName: undefined,
	};

	for (let index = 0; index < 10; index += 1) {
		signatureParams[`MediaUrl${index}`] = undefined;
		signatureParams[`MediaContentType${index}`] = undefined;
	}

	return { ...signatureParams, ...params };
}

export async function postInboundSms(
	webhookUrl: string,
	authToken: string,
	fromPhone: string,
	body: string,
): Promise<Response> {
	const formParams = {
		MessageSid: `SM${randomUUID().replaceAll("-", "").slice(0, 16)}`,
		AccountSid: "AC1234567890",
		From: fromPhone,
		To: "+15551234567",
		Body: body,
	};
	const signatureParams = buildInboundSignatureParams(formParams);
	const signature = computeTwilioSignature(authToken, webhookUrl, signatureParams);
	const bodyParams = new URLSearchParams(formParams);
	return fetch(webhookUrl, {
		method: "POST",
		headers: {
			"x-twilio-signature": signature,
			"content-type": "application/x-www-form-urlencoded",
		},
		body: bodyParams.toString(),
	});
}
