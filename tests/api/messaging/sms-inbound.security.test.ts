import { describe, expect, it, vi } from "vitest";
import { POST } from "../../../src/pages/api/messaging/inbound";

vi.mock(
	"../../../src/lib/messaging/sms/aws-sms-utils",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("../../../src/lib/messaging/sms/aws-sms-utils")
			>();
		return {
			...actual,
			createSmsClient: () => ({}),
			createSmsSender: () => async () => ({
				success: true,
				messageSid: "test-reply",
			}),
		};
	},
);

describe("Inbound SMS webhook security.", () => {
	it("Requests with non-JSON content type are rejected.", async () => {
		const response = await POST({
			request: new Request("http://localhost/api/messaging/inbound", {
				method: "POST",
				body: "not json",
				headers: { "Content-Type": "text/html" },
			}),
		} as never);

		expect(response.status).toBe(400);
		const body = await response.text();
		expect(body).toBe("Unsupported content type");
	});

	it("Requests with invalid JSON body are rejected.", async () => {
		const response = await POST({
			request: new Request("http://localhost/api/messaging/inbound", {
				method: "POST",
				body: "not valid json{",
				headers: { "Content-Type": "application/json" },
			}),
		} as never);

		expect(response.status).toBe(400);
		const body = await response.text();
		expect(body).toBe("Invalid JSON");
	});

	it("SNS messages with missing SMS payload fields are rejected.", async () => {
		const snsMessage = {
			Type: "Notification",
			MessageId: "test",
			TopicArn: "arn:aws:sns:us-east-1:123:test",
			Message: JSON.stringify({ originationNumber: "", messageBody: "" }),
			Timestamp: new Date().toISOString(),
			SignatureVersion: "1",
			Signature: "test",
			SigningCertURL: "https://sns.us-east-1.amazonaws.com/cert.pem",
		};

		const response = await POST({
			request: new Request("http://localhost/api/messaging/inbound", {
				method: "POST",
				body: JSON.stringify(snsMessage),
				headers: { "Content-Type": "application/json" },
			}),
		} as never);

		expect(response.status).toBe(400);
		const body = await response.text();
		expect(body).toBe("Missing required fields");
	});
});
