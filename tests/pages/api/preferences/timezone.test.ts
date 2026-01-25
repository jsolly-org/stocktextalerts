import { randomUUID } from "node:crypto";
import type { APIContext } from "astro";
import { describe, expect, it, vi } from "vitest";
import type { AppSupabaseClient } from "../../../../src/lib/db/supabase";
import { POST as POSTDismissBanner } from "../../../../src/pages/api/preferences/dismiss-timezone-banner";
import { POST } from "../../../../src/pages/api/preferences/timezone";
import { adminClient, allowConsoleErrors } from "../../../setup";
import { createAuthenticatedCookies, createTestUser } from "../../../utils";

const toRedirect = (url: string) =>
	new Response(null, {
		status: 302,
		headers: { Location: url },
	});

function createSupabaseTimezonesStub(options: {
	rows: Array<{
		value: string;
		label?: string;
		display_order?: number;
		active?: boolean;
	}>;
	delayMs?: number;
}) {
	let selectCount = 0;

	const delayMs = options.delayMs ?? 0;
	const rows = options.rows.map((row, index) => ({
		value: row.value,
		label: row.label ?? row.value,
		display_order: row.display_order ?? index,
		active: row.active ?? true,
	}));

	const supabase = {
		from: (table: string) => {
			if (table !== "timezones") {
				throw new Error(`Unexpected table: ${table}`);
			}

			return {
				select: (columns: string) => {
					if (columns !== "value,label,display_order,active") {
						throw new Error(`Unexpected columns: ${columns}`);
					}

					return {
						range: async (from: number, to: number) => {
							selectCount += 1;

							if (delayMs > 0) {
								await new Promise((resolve) => setTimeout(resolve, delayMs));
							}

							return { data: rows.slice(from, to + 1), error: null };
						},
					};
				},
			};
		},
	};

	return {
		supabase,
		getSelectCount: () => selectCount,
	};
}

describe("POST /api/preferences/timezone", () => {
	const TEST_PASSWORD = "TestPassword123!";

	it("updates the current user's timezone and redirects back", async () => {
		const testUser = await createTestUser({
			email: `test-timezone-${randomUUID()}@resend.dev`,
			password: TEST_PASSWORD,
			confirmed: true,
			timezone: "America/New_York",
		});

		const cookies = await createAuthenticatedCookies(
			testUser.email,
			TEST_PASSWORD,
		);

		const formData = new FormData();
		formData.append("timezone", "Etc/UTC");

		const request = new Request("http://localhost/api/preferences/timezone", {
			method: "POST",
			body: formData,
		});

		const response = await POST({
			request,
			cookies: {
				get: (name: string) => {
					const cookie = cookies.get(name);
					return cookie ? { value: cookie } : undefined;
				},
				set: () => {},
			},
			redirect: toRedirect,
		} as unknown as APIContext);

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(
			"/dashboard?success=timezone_updated#notification-preferences",
		);

		const { data: updatedUser, error } = await adminClient
			.from("users")
			.select("timezone")
			.eq("id", testUser.id)
			.single();

		expect(error).toBeNull();
		expect(updatedUser).not.toBeNull();
		expect(updatedUser.timezone).toBe("Etc/UTC");
	});

	it("returns JSON response when Accept header includes application/json", async () => {
		const testUser = await createTestUser({
			email: `test-timezone-json-${randomUUID()}@resend.dev`,
			password: TEST_PASSWORD,
			confirmed: true,
			timezone: "America/New_York",
		});

		const cookies = await createAuthenticatedCookies(
			testUser.email,
			TEST_PASSWORD,
		);

		const formData = new FormData();
		formData.append("timezone", "Etc/UTC");

		const request = new Request("http://localhost/api/preferences/timezone", {
			method: "POST",
			body: formData,
			headers: { Accept: "application/json" },
		});

		const response = await POST({
			request,
			cookies: {
				get: (name: string) => {
					const cookie = cookies.get(name);
					return cookie ? { value: cookie } : undefined;
				},
				set: () => {},
			},
			redirect: toRedirect,
		} as unknown as APIContext);

		expect(response.status).toBe(200);
		const json = await response.json();
		expect(json).toEqual({ ok: true, message: "timezone_updated" });

		const { data: updatedUser, error } = await adminClient
			.from("users")
			.select("timezone")
			.eq("id", testUser.id)
			.single();

		expect(error).toBeNull();
		expect(updatedUser).not.toBeNull();
		expect(updatedUser.timezone).toBe("Etc/UTC");
	});
});

describe("POST /api/preferences/dismiss-timezone-banner", () => {
	const TEST_PASSWORD = "TestPassword123!";

	it("sets dismiss_timezone_mismatch_prompts to true and redirects back", async () => {
		const testUser = await createTestUser({
			email: `test-dismiss-banner-${randomUUID()}@resend.dev`,
			password: TEST_PASSWORD,
			confirmed: true,
			timezone: "America/New_York",
		});

		const cookies = await createAuthenticatedCookies(
			testUser.email,
			TEST_PASSWORD,
		);

		const request = new Request(
			"http://localhost/api/preferences/dismiss-timezone-banner",
			{
				method: "POST",
			},
		);

		const response = await POSTDismissBanner({
			request,
			cookies: {
				get: (name: string) => {
					const cookie = cookies.get(name);
					return cookie ? { value: cookie } : undefined;
				},
				set: () => {},
			},
			redirect: toRedirect,
		} as unknown as APIContext);

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe(
			"/dashboard?success=timezone_banner_dismissed#notification-preferences",
		);

		const { data: updatedUser, error } = await adminClient
			.from("users")
			.select("dismiss_timezone_mismatch_prompts")
			.eq("id", testUser.id)
			.single();

		expect(error).toBeNull();
		expect(updatedUser).not.toBeNull();
		expect(updatedUser.dismiss_timezone_mismatch_prompts).toBe(true);
	});

	it("returns JSON response when Accept header includes application/json", async () => {
		const testUser = await createTestUser({
			email: `test-dismiss-banner-json-${randomUUID()}@resend.dev`,
			password: TEST_PASSWORD,
			confirmed: true,
			timezone: "America/New_York",
		});

		const cookies = await createAuthenticatedCookies(
			testUser.email,
			TEST_PASSWORD,
		);

		const request = new Request(
			"http://localhost/api/preferences/dismiss-timezone-banner",
			{
				method: "POST",
				headers: {
					Accept: "application/json",
				},
			},
		);

		const response = await POSTDismissBanner({
			request,
			cookies: {
				get: (name: string) => {
					const cookie = cookies.get(name);
					return cookie ? { value: cookie } : undefined;
				},
				set: () => {},
			},
			redirect: toRedirect,
		} as unknown as APIContext);

		expect(response.status).toBe(200);
		const json = await response.json();
		expect(json).toEqual({ ok: true });

		const { data: updatedUser, error } = await adminClient
			.from("users")
			.select("dismiss_timezone_mismatch_prompts")
			.eq("id", testUser.id)
			.single();

		expect(error).toBeNull();
		expect(updatedUser).not.toBeNull();
		expect(updatedUser.dismiss_timezone_mismatch_prompts).toBe(true);
	});

	it("redirects to /signin?error=unauthorized when user is not authenticated", async () => {
		allowConsoleErrors();

		const request = new Request(
			"http://localhost/api/preferences/dismiss-timezone-banner",
			{
				method: "POST",
			},
		);

		const response = await POSTDismissBanner({
			request,
			cookies: {
				get: () => undefined,
				set: () => {},
			},
			redirect: toRedirect,
		} as unknown as APIContext);

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("/signin?error=unauthorized");
	});
});

describe("resolveTimezone caching", () => {
	it("reuses cached timezone values within TTL", async () => {
		vi.resetModules();
		const { resolveTimezone } = await import("../../../../src/lib/time/cache");

		const stub = createSupabaseTimezonesStub({
			rows: [{ value: "Etc/UTC" }],
		});

		const first = await resolveTimezone({
			supabase: stub.supabase as unknown as AppSupabaseClient,
			detectedTimezone: "Etc/UTC",
		});
		const second = await resolveTimezone({
			supabase: stub.supabase as unknown as AppSupabaseClient,
			detectedTimezone: "Etc/UTC",
		});

		expect(first).toBe("Etc/UTC");
		expect(second).toBe("Etc/UTC");
		expect(stub.getSelectCount()).toBe(1);
	});

	it("dedupes concurrent loads (single in-flight query)", async () => {
		vi.resetModules();
		const { resolveTimezone } = await import("../../../../src/lib/time/cache");

		const stub = createSupabaseTimezonesStub({
			rows: [{ value: "Etc/UTC" }],
			delayMs: 20,
		});

		const [first, second] = await Promise.all([
			resolveTimezone({
				supabase: stub.supabase as unknown as AppSupabaseClient,
				detectedTimezone: "Etc/UTC",
			}),
			resolveTimezone({
				supabase: stub.supabase as unknown as AppSupabaseClient,
				detectedTimezone: "Etc/UTC",
			}),
		]);

		expect(first).toBe("Etc/UTC");
		expect(second).toBe("Etc/UTC");
		expect(stub.getSelectCount()).toBe(1);
	});
});

describe("getTimezoneOptions caching", () => {
	it("reuses cached timezones within TTL", async () => {
		vi.resetModules();
		const { getTimezoneOptions } = await import(
			"../../../../src/lib/time/cache"
		);

		const stub = createSupabaseTimezonesStub({
			rows: [
				{ value: "America/New_York", display_order: 1, active: true },
				{ value: "Europe/London", display_order: 2, active: true },
				{ value: "Etc/UTC", display_order: 3, active: false },
			],
		});

		const first = await getTimezoneOptions(
			stub.supabase as unknown as AppSupabaseClient,
			{ includeValues: ["Etc/UTC"] },
		);
		const second = await getTimezoneOptions(
			stub.supabase as unknown as AppSupabaseClient,
			{ includeValues: ["Etc/UTC"] },
		);

		expect(first.map((tz) => tz.value)).toEqual([
			"Etc/UTC",
			"America/New_York",
			"Europe/London",
		]);
		expect(second.map((tz) => tz.value)).toEqual([
			"Etc/UTC",
			"America/New_York",
			"Europe/London",
		]);
		expect(stub.getSelectCount()).toBe(1);
	});

	it("dedupes concurrent loads (single in-flight query)", async () => {
		vi.resetModules();
		const { getTimezoneOptions } = await import(
			"../../../../src/lib/time/cache"
		);

		const stub = createSupabaseTimezonesStub({
			rows: [
				{ value: "America/New_York", display_order: 1, active: true },
				{ value: "Europe/London", display_order: 2, active: true },
			],
			delayMs: 20,
		});

		const [first, second] = await Promise.all([
			getTimezoneOptions(stub.supabase as unknown as AppSupabaseClient),
			getTimezoneOptions(stub.supabase as unknown as AppSupabaseClient),
		]);

		expect(first.map((tz) => tz.value)).toEqual([
			"America/New_York",
			"Europe/London",
		]);
		expect(second.map((tz) => tz.value)).toEqual([
			"America/New_York",
			"Europe/London",
		]);
		expect(stub.getSelectCount()).toBe(1);
	});
});
