import type { APIContext } from "astro";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createVerifyCodeHandler } from "../../src/pages/api/auth/sms/verify-code";

const rpcMock = vi.fn();

vi.mock("../../src/lib/db/supabase", async () => {
	const actual = await vi.importActual<
		typeof import("../../src/lib/db/supabase")
	>("../../src/lib/db/supabase");
	return {
		...actual,
		createSupabaseAdminClient: () => ({
			rpc: rpcMock,
		}),
	};
});

describe("POST /api/auth/sms/verify-code", () => {
	beforeEach(() => {
		rpcMock.mockReset();
	});

	it("verifies the phone when the code is valid", async () => {
		const updateMock = vi.fn();
		const checkVerificationMock = vi.fn().mockResolvedValue({ success: true });
		const getByIdMock = vi.fn().mockResolvedValue({
			id: "user-id",
			phone_country_code: "+1",
			phone_number: "5550001234",
			verification_sent_at: new Date().toISOString(),
		});
		const getCurrentUserMock = vi.fn().mockResolvedValue({ id: "user-id" });
		rpcMock.mockResolvedValueOnce({ data: true, error: null });

		const handler = createVerifyCodeHandler({
			createSupabaseServerClient: () => ({}) as never,
			createUserService: () => ({
				getCurrentUser: getCurrentUserMock,
				getById: getByIdMock,
				update: updateMock,
			}),
			checkVerification: checkVerificationMock,
		});

		const formData = new FormData();
		formData.append("code", "123456");

		const response = await handler({
			request: new Request("http://localhost/api/auth/sms/verify-code", {
				method: "POST",
				body: formData,
			}),
			cookies: {
				get: () => undefined,
				set: () => {},
			},
		} as APIContext);

		expect(response.status).toBe(200);
		const json = await response.json();
		expect(json.ok).toBe(true);
		expect(json.message).toBe("phone_verified");
		expect(updateMock).toHaveBeenCalledWith("user-id", {
			phone_verified: true,
			verification_sent_at: null,
		});
	});

	it("returns invalid_code when the verification fails", async () => {
		const updateMock = vi.fn();
		const checkVerificationMock = vi
			.fn()
			.mockResolvedValue({ success: false, error: "invalid" });
		const getByIdMock = vi.fn().mockResolvedValue({
			id: "user-id",
			phone_country_code: "+1",
			phone_number: "5550001234",
			verification_sent_at: new Date().toISOString(),
		});
		const getCurrentUserMock = vi.fn().mockResolvedValue({ id: "user-id" });
		rpcMock.mockResolvedValueOnce({ data: true, error: null });

		const handler = createVerifyCodeHandler({
			createSupabaseServerClient: () => ({}) as never,
			createUserService: () => ({
				getCurrentUser: getCurrentUserMock,
				getById: getByIdMock,
				update: updateMock,
			}),
			checkVerification: checkVerificationMock,
		});

		const formData = new FormData();
		formData.append("code", "000000");

		const response = await handler({
			request: new Request("http://localhost/api/auth/sms/verify-code", {
				method: "POST",
				body: formData,
			}),
			cookies: {
				get: () => undefined,
				set: () => {},
			},
		} as APIContext);

		expect(response.status).toBe(400);
		const json = await response.json();
		expect(json.ok).toBe(false);
		expect(json.message).toBe("invalid_code");
		expect(updateMock).not.toHaveBeenCalled();
	});

	it("returns verification_rate_limited when rate limit is exceeded", async () => {
		const updateMock = vi.fn();
		const checkVerificationMock = vi.fn();
		const getByIdMock = vi.fn().mockResolvedValue({
			id: "user-id",
			phone_country_code: "+1",
			phone_number: "5550001234",
			verification_sent_at: new Date().toISOString(),
		});
		const getCurrentUserMock = vi.fn().mockResolvedValue({ id: "user-id" });
		rpcMock.mockResolvedValueOnce({ data: false, error: null });

		const handler = createVerifyCodeHandler({
			createSupabaseServerClient: () => ({}) as never,
			createUserService: () => ({
				getCurrentUser: getCurrentUserMock,
				getById: getByIdMock,
				update: updateMock,
			}),
			checkVerification: checkVerificationMock,
		});

		const formData = new FormData();
		formData.append("code", "123456");

		const response = await handler({
			request: new Request("http://localhost/api/auth/sms/verify-code", {
				method: "POST",
				body: formData,
			}),
			cookies: {
				get: () => undefined,
				set: () => {},
			},
		} as APIContext);

		expect(response.status).toBe(429);
		const json = await response.json();
		expect(json.ok).toBe(false);
		expect(json.message).toBe("verification_rate_limited");
		expect(checkVerificationMock).not.toHaveBeenCalled();
		expect(updateMock).not.toHaveBeenCalled();
	});
});
