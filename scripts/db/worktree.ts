/**
 * scripts/db/worktree.ts — git-worktree detection + the local-dev safety policy.
 *
 * `findMainWorktreeRoot` was duplicated in link-worktree-data.ts; it now lives here.
 * All worktrees share ONE local Supabase stack (default ports, project_id "stocktextalerts"),
 * so the old per-worktree "is this worktree's Supabase provisioned?" checks are gone — the only
 * remaining policy is `symlinkedNodeModulesMessage` (a Vite server.fs.allow footgun, orthogonal
 * to Supabase). See docs/plans/2026-06-21-shared-local-supabase-stack.md.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..", "..");

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
