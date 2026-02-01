import { describe, expect, it, vi } from "vitest";
import { POST } from "../../src/pages/api/notifications/sms/inbound";
import { allowConsoleErrors } from "../setup";
import { buildSmsInboundRequest } from "../shared-utils";

const { validateRequestMock } = vi.hoisted(() => ({
	validateRequestMock: vi.fn(),
}));

vi.mock("twilio", () => ({
	default: {
		validateRequest: validateRequestMock,
	},
}));

describe("A user manages SMS notifications by replying to messages.", () => {
	it("Requests without a valid signature are rejected before processing.", async () => {
		vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token");

		const response = await POST({
			request: buildSmsInboundRequest({
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
			request: buildSmsInboundRequest({
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
