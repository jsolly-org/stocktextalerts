import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..", "..");

const WORKTREE_CONFIG = path.join(projectRoot, "supabase", ".worktree", "config.toml");

/** Extra Supabase CLI flags when this worktree uses an isolated local stack. */
export function supabaseCliArgs(): string[] {
	if (fs.existsSync(WORKTREE_CONFIG)) {
		return ["--config", WORKTREE_CONFIG];
	}
	return [];
}

export function worktreeSupabaseConfigPath(): string | null {
	return fs.existsSync(WORKTREE_CONFIG) ? WORKTREE_CONFIG : null;
}
