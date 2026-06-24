import { afterEach, describe, expect, it } from "vitest";
import { createSupabaseAdminClient } from "../../../src/lib/db/supabase";
import {
	claimEmailDispatchKey,
	releaseEmailDispatchKey,
} from "../../../src/lib/messaging/email/dispatch-idempotency";

const TEST_KEY = "scheduled-update/test-user-abc/2026-06-13/540/email";

afterEach(async () => {
	await createSupabaseAdminClient()
		.from("email_dispatch_idempotency")
		.delete()
		.eq("idempotency_key", TEST_KEY);
});

describe("claimEmailDispatchKey", () => {
	it("A first dispatch claims the key; an identical retry is rejected as a duplicate", async () => {
		const supabase = createSupabaseAdminClient();

		const first = await claimEmailDispatchKey(supabase, TEST_KEY);
		expect(first).toBe("claimed");

		const second = await claimEmailDispatchKey(supabase, TEST_KEY);
		expect(second).toBe("duplicate");
	});

	it("A failed dispatch releases its key so a retry can re-claim and deliver", async () => {
		const supabase = createSupabaseAdminClient();
		const key = "daily-digest/test-user-xyz/2026-06-13/540/email";
		try {
			expect(await claimEmailDispatchKey(supabase, key)).toBe("claimed");
			// Simulate the handler's release-on-failure:
			await releaseEmailDispatchKey(supabase, key);
			// A retry must be able to re-claim (NOT be blocked as a duplicate):
			expect(await claimEmailDispatchKey(supabase, key)).toBe("claimed");
		} finally {
			await supabase.from("email_dispatch_idempotency").delete().eq("idempotency_key", key);
		}
	});

	it("An expired claim is re-claimable, so a claim the dispatcher kept on an ambiguous failure self-heals after its TTL", async () => {
		const supabase = createSupabaseAdminClient();
		const key = "scheduled-update/ttl-reclaim-user/2026-06-13/540/email";
		try {
			expect(await claimEmailDispatchKey(supabase, key)).toBe("claimed");
			// A live (unexpired) claim still blocks a duplicate — no double-send window.
			expect(await claimEmailDispatchKey(supabase, key)).toBe("duplicate");

			// Expire the claim in place, simulating the TTL lapsing on a claim that the dispatcher
			// deliberately kept after an ambiguous SES outcome.
			const { error } = await supabase
				.from("email_dispatch_idempotency")
				.update({ expires_at: "2000-01-01T00:00:00Z" })
				.eq("idempotency_key", key);
			expect(error).toBeNull();

			// The expired key is now re-claimable — a genuine later retry is not suppressed forever.
			expect(await claimEmailDispatchKey(supabase, key)).toBe("claimed");
		} finally {
			await supabase.from("email_dispatch_idempotency").delete().eq("idempotency_key", key);
		}
	});

	it("Releasing a key that was never claimed is a safe no-op", async () => {
		const supabase = createSupabaseAdminClient();
		await expect(
			releaseEmailDispatchKey(supabase, "daily-digest/never-claimed/2026-06-13/540/email"),
		).resolves.toBeUndefined();
	});
});
