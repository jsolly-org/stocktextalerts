import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { POST as assetsUpdatePost } from "../../../src/pages/api/assets/update";
import { createApiContext } from "../../helpers/api-context";
import { TEST_PASSWORD } from "../../helpers/constants";
import { adminClient, createAuthenticatedCookies } from "../../helpers/test-env";
import { createTestUser } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";

function getPublishableEnv() {
	return {
		supabaseUrl: process.env.SUPABASE_URL as string,
		supabasePublishableKey: process.env.SUPABASE_PUBLISHABLE_KEY as string,
	};
}

async function createUserClient(accessToken: string, refreshToken: string) {
	const { supabaseUrl, supabasePublishableKey } = getPublishableEnv();
	const client = createClient(supabaseUrl, supabasePublishableKey, {
		auth: { autoRefreshToken: false, persistSession: false },
	});
	const { error } = await client.auth.setSession({
		access_token: accessToken,
		refresh_token: refreshToken,
	});
	if (error) {
		throw new Error(`Failed to set session: ${error.message}`);
	}
	return client;
}

describe("Manual user approval enforcement", () => {
	it("An unapproved user cannot read protected user-owned rows via RLS.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@example.com`,
			password: TEST_PASSWORD,
			confirmed: true,
			approved: false,
			trackedAssets: ["AAPL"],
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(testUser.email, TEST_PASSWORD);
		const client = await createUserClient(
			cookies.get("sb-access-token") ?? "",
			cookies.get("sb-refresh-token") ?? "",
		);

		const { data: profileRows, error: profileError } = await client
			.from("users")
			.select("approved_at")
			.eq("id", testUser.id)
			.single();
		expect(profileError).toBeNull();
		expect(profileRows?.approved_at).toBeNull();

		const { data: assetRows, error: assetError } = await client
			.from("user_assets")
			.select("symbol")
			.eq("user_id", testUser.id);
		expect(assetError).toBeNull();
		expect(assetRows).toEqual([]);
	});

	it("An unapproved user cannot self-approve via profile update.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@example.com`,
			password: TEST_PASSWORD,
			confirmed: true,
			approved: false,
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(testUser.email, TEST_PASSWORD);
		const client = await createUserClient(
			cookies.get("sb-access-token") ?? "",
			cookies.get("sb-refresh-token") ?? "",
		);

		const { data: updatedRows, error } = await client
			.from("users")
			.update({
				approved_at: new Date().toISOString(),
				approved_by: "self",
			})
			.eq("id", testUser.id)
			.select("id");

		expect(error).toBeNull();
		expect(updatedRows).toEqual([]);

		const { data: row, error: readError } = await adminClient
			.from("users")
			.select("approved_at, approved_by")
			.eq("id", testUser.id)
			.single();
		expect(readError).toBeNull();
		expect(row?.approved_at).toBeNull();
		expect(row?.approved_by).toBeNull();
	});

	it("Service role can approve a pending user.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@example.com`,
			password: TEST_PASSWORD,
			confirmed: true,
			approved: false,
		});
		registerTestUserForCleanup(testUser.id);

		const approvedAt = new Date().toISOString();
		const { error } = await adminClient
			.from("users")
			.update({ approved_at: approvedAt, approved_by: "test-admin" })
			.eq("id", testUser.id);
		expect(error).toBeNull();

		const { data: row, error: readError } = await adminClient
			.from("users")
			.select("approved_at, approved_by")
			.eq("id", testUser.id)
			.single();
		expect(readError).toBeNull();
		expect(row?.approved_at).toBeTruthy();
		expect(row?.approved_by).toBe("test-admin");
	});

	it("A protected API route rejects an unapproved authenticated user.", async () => {
		const testUser = await createTestUser({
			email: `test-${randomUUID()}@example.com`,
			password: TEST_PASSWORD,
			confirmed: true,
			approved: false,
		});
		registerTestUserForCleanup(testUser.id);

		const cookies = await createAuthenticatedCookies(testUser.email, TEST_PASSWORD);
		const formData = new FormData();
		formData.set("tracked_assets", JSON.stringify(["AAPL"]));

		const response = await assetsUpdatePost(
			createApiContext({
				request: new Request("http://localhost/api/assets/update", {
					method: "POST",
					body: formData,
				}),
				cookies,
			}),
		);

		expect(response.status).toBe(401);
	});
});
