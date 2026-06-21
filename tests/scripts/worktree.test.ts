import { describe, expect, it } from "vitest";

import { symlinkedNodeModulesMessage } from "../../scripts/db/worktree";

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
