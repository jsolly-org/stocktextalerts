import { describe, expect, it } from "vitest";
import { adminClient } from "../helpers/test-env";
import { cleanupTestUser, createTestUser } from "../helpers/test-user";

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
			const { error: deleteError } = await adminClient.auth.admin.deleteUser(
				testUser.id,
			);
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

	it("Child rows like user_stocks are also removed when the auth user is deleted.", async () => {
		const testUser = await createTestUser({
			confirmed: true,
			trackedStocks: ["AAPL", "MSFT"],
		});
		let cleanupNeeded = true;

		try {
			// Verify user_stocks rows exist
			const { data: stocksBefore } = await adminClient
				.from("user_stocks")
				.select("symbol")
				.eq("user_id", testUser.id);
			expect(stocksBefore).toHaveLength(2);

			// Delete only the auth user
			const { error: deleteError } = await adminClient.auth.admin.deleteUser(
				testUser.id,
			);
			expect(deleteError).toBeNull();

			// Both public.users and user_stocks should be gone
			const { data: userAfter } = await adminClient
				.from("users")
				.select("id")
				.eq("id", testUser.id)
				.maybeSingle();
			expect(userAfter).toBeNull();

			const { data: stocksAfter } = await adminClient
				.from("user_stocks")
				.select("symbol")
				.eq("user_id", testUser.id);
			expect(stocksAfter).toHaveLength(0);

			cleanupNeeded = false;
		} finally {
			if (cleanupNeeded) {
				await cleanupTestUser(testUser.id);
			}
		}
	});
});
