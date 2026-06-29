import { describe, expect, it } from "vitest";
import { activeSetTooSmallToFlag } from "../../../src/lib/assets/universe-reconcile-floor";

// The step-3 delist-flag guard used to gate on `active.length < storedActive * 0.5`, which tripped
// EVERY nightly run in production (active ~11k vs ~28k seeded mostly-historical non-delisted rows)
// and permanently deadlocked the untracked-delisting backlog drain. It now gates on an ABSOLUTE
// floor. The integration suite (universe-reconcile.test.ts) cannot pin this: keeping an active set
// between the floor and stored-active would mass-flag thousands of shared seed rows (see the
// `activeSetCoveringSeedExcept` helper + its comment). This pure-predicate test is therefore the
// only place that asserts both the floor boundary AND the comparison direction — crucially that the
// decision no longer depends on stored-active, so the real prod 11k-vs-28k ratio FLAGS rather than
// skips. Reverting the source to the old stored-relative formula must turn one of these red.
describe("activeSetTooSmallToFlag (universe-reconcile truncation floor)", () => {
	it("treats a single-page-sized active set as a suspected truncation (skips delist-flagging)", () => {
		expect(activeSetTooSmallToFlag(0)).toBe(true);
		expect(activeSetTooSmallToFlag(1)).toBe(true);
		expect(activeSetTooSmallToFlag(1000)).toBe(true); // one Massive list page
		expect(activeSetTooSmallToFlag(4999)).toBe(true); // just under the floor
	});

	it("treats the real active universe as plausible regardless of how large stored-active is", () => {
		// The load-bearing assertion: 11_023 is the live US stock+ETF active count. Under the old
		// `active < storedActive * 0.5` formula this SKIPPED against ~28k stored-active (the deadlock
		// that fired stocktextalerts-error-logs nightly). The absolute floor proceeds to flag it.
		expect(activeSetTooSmallToFlag(5000)).toBe(false); // floor is exclusive
		expect(activeSetTooSmallToFlag(11_023)).toBe(false); // observed prod active set
		expect(activeSetTooSmallToFlag(28_495)).toBe(false); // even at the inflated stored size
	});
});
