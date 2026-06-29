import { describe, expect, it } from "vitest";
import { adminClient } from "../../helpers/test-env";
import { cleanupTestUser, createTestUser } from "../../helpers/test-user";

describe("Deleting an auth user cascades to application data.", () => {
	it("The public.users row is deleted when the auth user is removed.", async () => {
		const testUser = await createTestUser({ confirmed: true });
		let cleanupNeeded = true;

		try {
			// Verify public.users row exists before deletion
			const { data: before } = await adminClient
				.from("users")
				.select("id")
				.eq("id", testUser.id)
				.maybeSingle();
			expect(before).not.toBeNull();

			// Delete only the auth user — the trigger should cascade
			const { error: deleteError } = await adminClient.auth.admin.deleteUser(testUser.id);
			expect(deleteError).toBeNull();

			// The public.users row should now be gone
			const { data: after, error: afterError } = await adminClient
				.from("users")
				.select("id")
				.eq("id", testUser.id)
				.maybeSingle();
			expect(afterError).toBeNull();
			expect(after).toBeNull();

			cleanupNeeded = false;
		} finally {
			if (cleanupNeeded) {
				await cleanupTestUser(testUser.id);
			}
		}
	});

	it("Child rows like user_assets are also removed when the auth user is deleted.", async () => {
		const testUser = await createTestUser({
			confirmed: true,
			trackedAssets: ["AAPL", "MSFT"],
		});
		let cleanupNeeded = true;

		try {
			// Verify user_assets rows exist
			const { data: assetsBefore } = await adminClient
				.from("user_assets")
				.select("symbol")
				.eq("user_id", testUser.id);
			expect(assetsBefore).toHaveLength(2);

			// Delete only the auth user
			const { error: deleteError } = await adminClient.auth.admin.deleteUser(testUser.id);
			expect(deleteError).toBeNull();

			// Both public.users and user_assets should be gone
			const { data: userAfter } = await adminClient
				.from("users")
				.select("id")
				.eq("id", testUser.id)
				.maybeSingle();
			expect(userAfter).toBeNull();

			const { data: assetsAfter } = await adminClient
				.from("user_assets")
				.select("symbol")
				.eq("user_id", testUser.id);
			expect(assetsAfter).toHaveLength(0);

			cleanupNeeded = false;
		} finally {
			if (cleanupNeeded) {
				await cleanupTestUser(testUser.id);
			}
		}
	});
});
