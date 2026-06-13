/**
 * scripts/db/worktree.ts — single source of truth for git-worktree detection, the
 * "is this worktree's Supabase provisioned?" check, and the local-DB safety policies.
 *
 * `findMainWorktreeRoot` was duplicated in link-worktree-data.ts and worktree-supabase.ts;
 * it now lives here. The pure *-Message policies are kept side-effect-free so they unit-test
 * without git/fs state; reset.ts / doctor.ts feed them real state.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..", "..");
const WORKTREE_META = path.join(projectRoot, "supabase", ".worktree", "meta.json");

/** Main worktree root if running in a LINKED worktree, else null (main checkout / not a repo). */
export function findMainWorktreeRoot(): string | null {
	let gitDir: string;
	let gitCommonDir: string;
	try {
		gitDir = execFileSync("git", ["rev-parse", "--git-dir"], {
			cwd: projectRoot,
			encoding: "utf8",
		}).trim();
		gitCommonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
			cwd: projectRoot,
			encoding: "utf8",
		}).trim();
	} catch {
		return null;
	}

	const absoluteGitDir = path.resolve(projectRoot, gitDir);
	const absoluteCommonDir = path.resolve(projectRoot, gitCommonDir);
	// In a linked worktree git-dir is .git/worktrees/<name>/ while common-dir is the main repo's
	// .git/. Equal ⇒ this IS the main checkout.
	if (absoluteGitDir === absoluteCommonDir) return null;
	return path.dirname(absoluteCommonDir);
}

export function isLinkedWorktree(): boolean {
	return findMainWorktreeRoot() !== null;
}

/**
 * True when this worktree has an isolated Supabase stack provisioned. The sentinel is the
 * gitignored supabase/.worktree/meta.json that worktree-supabase.ts writes alongside the isolated
 * config.toml. (Replaces the removed config-path check — see 2026-06-13-worktree-supabase-cli-fix.)
 */
export function worktreeSupabaseProvisioned(): boolean {
	return fs.existsSync(WORKTREE_META);
}

/**
 * Pure policy: refusal message when running `db:reset` would be unsafe, else null.
 *
 * Unsafe iff we're in a linked worktree that has NOT been provisioned — there, db:reset reads the
 * worktree's still-default config.toml (port 54322) and would wipe the shared/main stack's seed.
 */
export function unsafeResetMessage(linkedWorktree: boolean, provisioned: boolean): string | null {
	if (linkedWorktree && !provisioned) {
		return [
			"",
			"✋ db:reset refused: this linked worktree has no isolated Supabase stack.",
			"   Running it would target the shared/main stack (port 54322) and wipe its seed.",
			"   Provision the worktree first:  npm run worktree:init",
			"   (or, DB only:  npm run db:bootstrap)",
			"",
		].join("\n");
	}
	return null;
}

/** Pure policy: refusal message when node_modules is a symlink (breaks Vite server.fs.allow), else null. */
export function symlinkedNodeModulesMessage(nodeModulesIsSymlink: boolean): string | null {
	if (!nodeModulesIsSymlink) return null;
	return [
		"",
		"✋ node_modules is a symlink. It resolves outside the worktree root, so Vite",
		"   (server.fs.allow) refuses to serve dependencies → 403 → Vue islands fail to hydrate.",
		"   Replace it with a real install:  rm node_modules && npm run worktree:init",
		"",
	].join("\n");
}

/** Pure policy: hint when in a linked, unprovisioned worktree, else null. */
export function unprovisionedWorktreeMessage(
	linkedWorktree: boolean,
	provisioned: boolean,
): string | null {
	if (linkedWorktree && !provisioned) {
		return [
			"",
			"✋ This linked worktree has no isolated Supabase stack — it is not provisioned.",
			"   Run:  npm run worktree:init",
			"",
		].join("\n");
	}
	return null;
}
