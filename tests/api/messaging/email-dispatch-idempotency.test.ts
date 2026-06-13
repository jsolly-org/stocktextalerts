import { afterEach, describe, expect, it } from "vitest";
import { createSupabaseAdminClient } from "../../../src/lib/db/supabase";
import { claimEmailDispatchKey } from "../../../src/lib/messaging/email/dispatch-idempotency";

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
});
