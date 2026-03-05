import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "../../../src/pages/api/messaging/inbound";
import { createApiContext } from "../../helpers/api-context";
import { buildSmsInboundRequest } from "../../helpers/request-helpers";

const { validateRequestMock } = vi.hoisted(() => ({
	validateRequestMock: vi.fn(),
}));

vi.mock("twilio", () => ({
	default: {
		validateRequest: validateRequestMock,
	},
}));

describe("A user manages SMS notifications by replying to messages.", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("Requests without a valid signature are rejected before processing.", async () => {
		vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token");

		const response = await POST(
			createApiContext({
				request: buildSmsInboundRequest({
					from: "+15005550006",
					body: "STOP",
					includeSignature: false,
				}),
			}),
		);

		expect(response.status).toBe(401);
		const body = await response.text();
		expect(body).toBe("Missing Twilio signature");
	});

	it("Requests with an invalid signature are rejected.", async () => {
		vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token");
		validateRequestMock.mockReturnValueOnce(false);

		const response = await POST(
			createApiContext({
				request: buildSmsInboundRequest({
					from: "+15005550006",
					body: "STOP",
					includeSignature: true,
				}),
			}),
		);

		expect(response.status).toBe(403);
		const body = await response.text();
		expect(body).toBe("Invalid signature");
	});
});
