import { describe, expect, it, vi } from "vitest";
import type { AppSupabaseClient } from "../../../../src/lib/db/supabase";
import { sendUserSms } from "../../../../src/lib/messaging/sms/index";
import type { SmsSender } from "../../../../src/lib/messaging/sms/types";
import type { SmsUser } from "../../../../src/lib/messaging/types";
import { expectConsoleError } from "../../../setup";

const testUser: SmsUser = {
	id: "user-123",
	phone_country_code: "+1",
	phone_number: "5551234567",
};

function createMockSupabase() {
	const updateFn = vi.fn().mockReturnValue({
		eq: vi.fn().mockResolvedValue({ error: null }),
	});
	return {
		from: vi.fn().mockReturnValue({ update: updateFn }),
		__updateFn: updateFn,
	} as unknown as AppSupabaseClient & { __updateFn: ReturnType<typeof vi.fn> };
}

describe("sendUserSms 21610 auto opt-out", () => {
	it("auto opts out user when Twilio returns error 21610", async () => {
		const sender: SmsSender = async () => ({
			success: false as const,
			error: "Attempt to send to unsubscribed recipient",
			errorCode: "21610",
		});
		const supabase = createMockSupabase();

		const result = await sendUserSms(testUser, "Hello", sender, supabase);

		expect(result.success).toBe(false);
		expect(supabase.from).toHaveBeenCalledWith("users");
		expect(supabase.__updateFn).toHaveBeenCalledWith({
			sms_opted_out: true,
			sms_notifications_enabled: false,
		});
	});

	it("does not opt out user on other error codes", async () => {
		const sender: SmsSender = async () => ({
			success: false as const,
			error: "Some other error",
			errorCode: "30001",
		});
		const supabase = createMockSupabase();

		await sendUserSms(testUser, "Hello", sender, supabase);

		expect(supabase.from).not.toHaveBeenCalled();
	});

	it("does not opt out when supabase is not provided", async () => {
		const sender: SmsSender = async () => ({
			success: false as const,
			error: "Attempt to send to unsubscribed recipient",
			errorCode: "21610",
		});

		const result = await sendUserSms(testUser, "Hello", sender);
		expect(result.success).toBe(false);
	});

	it("handles 21610 from unexpected errors in catch block", async () => {
		expectConsoleError("Unexpected error sending SMS");
		const error = new Error("Unsubscribed recipient") as Error & {
			code: string;
		};
		error.code = "21610";
		const sender: SmsSender = async () => {
			throw error;
		};
		const supabase = createMockSupabase();

		const result = await sendUserSms(testUser, "Hello", sender, supabase);

		expect(result.success).toBe(false);
		expect(supabase.from).toHaveBeenCalledWith("users");
	});
});
