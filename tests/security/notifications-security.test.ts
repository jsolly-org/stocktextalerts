import { describe, expect, it, vi } from "vitest";
import { POST } from "../../src/pages/api/notifications/sms/inbound";
import { allowConsoleErrors } from "../setup";

const { validateRequestMock } = vi.hoisted(() => ({
	validateRequestMock: vi.fn(),
}));

vi.mock("twilio", () => ({
	default: {
		validateRequest: validateRequestMock,
	},
}));

function buildRequest(options: {
	from: string;
	body: string;
	includeSignature?: boolean;
}) {
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

describe("A user manages SMS notifications by replying to messages.", () => {
	it("Requests without a valid signature are rejected before processing.", async () => {
		vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token");

		const response = await POST({
			request: buildRequest({
				from: "+15005550006",
				body: "STOP",
				includeSignature: false,
			}),
		} as never);

		expect(response.status).toBe(401);
		const body = await response.text();
		expect(body).toBe("Missing Twilio signature");
		vi.unstubAllEnvs();
	});

	it("Requests with an invalid signature are rejected.", async () => {
		allowConsoleErrors();
		vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token");
		validateRequestMock.mockReturnValueOnce(false);

		const response = await POST({
			request: buildRequest({
				from: "+15005550006",
				body: "STOP",
				includeSignature: true,
			}),
		} as never);

		expect(response.status).toBe(403);
		const body = await response.text();
		expect(body).toBe("Invalid signature");
		vi.unstubAllEnvs();
	});
});
