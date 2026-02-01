export function toRedirect(url: string, status = 302): Response {
	return new Response(null, {
		status,
		headers: { Location: url },
	});
}

export function buildSmsInboundRequest(options: {
	from: string;
	body: string;
	includeSignature?: boolean;
}): Request {
	const formData = new FormData();
	formData.append("MessageSid", "SM123");
	formData.append("AccountSid", "AC123");
	formData.append("From", options.from);
	formData.append("To", "+15551234567");
	formData.append("Body", options.body);

	const headers: Record<string, string> = {};
	if (options.includeSignature) {
		headers["x-twilio-signature"] = "test-signature";
	}

	return new Request("http://localhost/api/notifications/sms/inbound", {
		method: "POST",
		body: formData,
		headers,
	});
}
