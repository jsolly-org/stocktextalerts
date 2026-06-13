import { describe, expect, it } from "vitest";

import {
	symlinkedNodeModulesMessage,
	unprovisionedWorktreeMessage,
	unsafeResetMessage,
} from "../../scripts/db/worktree";

// unsafeResetMessage: db:reset is unsafe only in a linked worktree that has NOT been provisioned
// with its own isolated Supabase stack — there, reset would hit the shared/main stack (port 54322)
// and wipe its seed (worktree-provisioning issue #3).
describe("unsafeResetMessage", () => {
	it("refuses reset in a linked, unprovisioned worktree", () => {
		const msg = unsafeResetMessage(true, false);
		expect(msg).not.toBeNull();
		expect(msg).toContain("worktree:init");
	});
	it("allows reset in a provisioned worktree (isolated stack)", () => {
		expect(unsafeResetMessage(true, true)).toBeNull();
	});
	it("allows reset in the main checkout (not a linked worktree)", () => {
		expect(unsafeResetMessage(false, false)).toBeNull();
		expect(unsafeResetMessage(false, true)).toBeNull();
	});
});

describe("symlinkedNodeModulesMessage", () => {
	it("flags a symlinked node_modules (breaks Vite server.fs.allow)", () => {
		const msg = symlinkedNodeModulesMessage(true);
		expect(msg).not.toBeNull();
		expect(msg).toContain("symlink");
	});
	it("allows a real node_modules directory", () => {
		expect(symlinkedNodeModulesMessage(false)).toBeNull();
	});
});

describe("unprovisionedWorktreeMessage", () => {
	it("flags a linked worktree with no isolated stack", () => {
		const msg = unprovisionedWorktreeMessage(true, false);
		expect(msg).not.toBeNull();
		expect(msg).toContain("worktree:init");
	});
	it("allows a provisioned worktree or the main checkout", () => {
		expect(unprovisionedWorktreeMessage(true, true)).toBeNull();
		expect(unprovisionedWorktreeMessage(false, false)).toBeNull();
	});
});
