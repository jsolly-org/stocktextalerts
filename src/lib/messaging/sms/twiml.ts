// Twilio expects a TwiML (XML) response body to render an SMS reply.
/**
 * Wrap a message string in a minimal TwiML (XML) response body for Twilio webhooks.
 */
export function wrapInTwiml(message: string): string {
	const twiml = ['<?xml version="1.0" encoding="UTF-8"?>', "<Response>"];
	if (message) {
		twiml.push(`\t<Message>${escapeForXml(message)}</Message>`);
	}
	twiml.push("</Response>");
	return twiml.join("\n");
}

function escapeForXml(message: string): string {
	const replacements: Record<string, string> = {
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		'"': "&quot;",
		"'": "&apos;",
	};

	return message.replace(/[&<>"']/g, (character) => {
		return replacements[character] ?? character;
	});
}
