import { describe, expect, it } from "vitest";
import { isConsumedEmailOtpError } from "../../../src/lib/auth/supabase-otp";

describe("isConsumedEmailOtpError", () => {
	it("returns true for otp_expired and otp_disabled codes", () => {
		expect(isConsumedEmailOtpError({ code: "otp_expired", message: "expired" })).toBe(true);
		expect(isConsumedEmailOtpError({ code: "otp_disabled", message: "disabled" })).toBe(true);
	});

	it("returns true when the message mentions expiry or prior use", () => {
		expect(
			isConsumedEmailOtpError({
				message: "Email link is invalid or has expired",
			}),
		).toBe(true);
		expect(
			isConsumedEmailOtpError({
				message: "Token has already been used",
			}),
		).toBe(true);
		expect(isConsumedEmailOtpError({ message: "Non-Error thrown" })).toBe(true);
	});

	it("returns false for unexpected verification failures", () => {
		expect(isConsumedEmailOtpError(null)).toBe(false);
		expect(isConsumedEmailOtpError({ code: "validation_failed", message: "bad token" })).toBe(
			false,
		);
	});
});
