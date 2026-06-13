/**
 * scripts/db/link-worktree-data.ts — propagate gitignored local-dev files into a fresh worktree.
 *
 * Without this, a fresh `git worktree add` produces a working copy that's
 * missing `.env.local` and `scripts/data/users.json` (both gitignored).
 * `npm run dev` errors on missing `SUPABASE_URL`; `npm run db:reset`
 * silently skips auth-user seeding so login fails after the next reseed.
 *
 * For each candidate file: if the worktree doesn't already have it AND
 * the main worktree does, symlink the worktree path to the main file.
 * Symlinks (vs copies) so edits flow both ways — these files change rarely
 * and developers expect their personal seed/env to follow them around.
 * Linked worktrees: `db:worktree-setup` later replaces a symlinked `.env.local`
 * with a copied, port-patched file for isolated Supabase stacks.
 *
 * No-ops in three cases:
 *   1. Not running in a linked worktree (GIT_DIR == GIT_COMMON_DIR).
 *   2. The candidate file already exists in this worktree (file or symlink).
 *   3. The main worktree doesn't have the candidate either.
 *
 * Wired into `db:bootstrap` so it runs once per worktree on first setup.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { rootLogger } from "../../src/lib/logging";
import { findMainWorktreeRoot } from "./worktree";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..", "..");

const FILES_TO_LINK = [".env.local", "scripts/data/users.json"];

function alreadyExists(targetPath: string): boolean {
	try {
		fs.lstatSync(targetPath);
		return true;
	} catch {
		return false;
	}
}

function linkOne(mainRoot: string, relativePath: string): "linked" | "skipped" | "missing-source" {
	const target = path.join(projectRoot, relativePath);
	if (alreadyExists(target)) return "skipped";

	const source = path.join(mainRoot, relativePath);
	if (!fs.existsSync(source)) return "missing-source";

	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.symlinkSync(source, target);
	return "linked";
}

function main(): void {
	const mainRoot = findMainWorktreeRoot();
	if (!mainRoot) {
		rootLogger.info("link-worktree-data — not in a linked worktree, nothing to do", {
			action: "link_worktree_data",
			reason: "not_a_worktree",
		});
		return;
	}

	const linked: string[] = [];
	const skipped: string[] = [];
	const missing: string[] = [];

	for (const rel of FILES_TO_LINK) {
		const result = linkOne(mainRoot, rel);
		if (result === "linked") linked.push(rel);
		else if (result === "skipped") skipped.push(rel);
		else missing.push(rel);
	}

	rootLogger.info("link-worktree-data — done", {
		action: "link_worktree_data",
		mainRoot,
		linked,
		skipped,
		missingInMain: missing,
	});
}

main();
