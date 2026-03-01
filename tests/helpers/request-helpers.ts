export function toRedirect(url: string, status = 302): Response {
	return new Response(null, {
		status,
		headers: { Location: url },
	});
}

export function buildSmsInboundRequest(options: {
	from: string;
	body: string;
}): Request {
	const smsPayload = {
		originationNumber: options.from,
		messageBody: options.body,
		destinationNumber: "+15551234567",
		messageKeyword: "keyword",
	};

	const snsMessage = {
		Type: "Notification",
		MessageId: "test-message-id",
		TopicArn: "arn:aws:sns:us-east-1:123456789:test-topic",
		Message: JSON.stringify(smsPayload),
		Timestamp: new Date().toISOString(),
		SignatureVersion: "1",
		Signature: "test-signature",
		SigningCertURL: "https://sns.us-east-1.amazonaws.com/cert.pem",
	};

	return new Request("http://localhost/api/messaging/inbound", {
		method: "POST",
		body: JSON.stringify(snsMessage),
		headers: {
			"Content-Type": "application/json",
		},
	});
}
