/**
 * scripts/db/collapse-worktree-stacks.ts — one-shot migration from per-worktree isolated Supabase
 * stacks to ONE shared stack (default ports, project_id "stocktextalerts").
 *
 * The old model (deleted scripts/db/worktree-supabase.ts) gave every linked worktree its own
 * stack: a skip-worktree'd supabase/config.toml with project_id "stocktextalerts-wt-<slug>" +
 * offset ports, a port-patched .env.local, a supabase/.worktree/meta.json sentinel, and a full
 * ~1GB podman stack. N worktrees → N stacks → the 7.45GiB swapless VM OOM-wedged podman. This
 * script collapses each existing worktree back onto the shared stack and tears down the orphaned
 * podman resources.
 *
 * Per linked worktree it: (1) clears skip-worktree on supabase/config.toml and restores the
 * committed version (project_id "stocktextalerts", default ports) — but SKIPS with a warning if
 * config.toml has local edits beyond the project_id/port lines; (2) removes supabase/.worktree/;
 * (3) rewrites only the three port lines of .env.local IN PLACE (preserving any personal vars).
 * Then it force-removes every podman container + volume whose name contains "stocktextalerts-wt-".
 *
 * SAFETY (cf. docs/incidents/2026-05-cloudformation-stack-deletion.md — "never loop over all"):
 * the podman teardown is allowlist-only. A target MUST contain the literal "stocktextalerts-wt-"
 * substring; the main stack's resources ("supabase_db_stocktextalerts", no "-wt-") can never match,
 * and an explicit assertion throws if any computed target lacks "-wt-". Destroys throwaway local DB
 * data only (db:bootstrap reseeds).
 *
 * DRY-RUN BY DEFAULT. It prints the plan and changes nothing unless you pass `--apply`.
 *
 *   npm run db:collapse-worktree-stacks          # dry run — show the plan
 *   npm run db:collapse-worktree-stacks -- --apply   # execute
 *
 * Idempotent: re-running on an already-collapsed fleet is a no-op.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SHARED_PROJECT_ID = "stocktextalerts";
const WT_MARKER = "stocktextalerts-wt-"; // the allowlist discriminator — main stack lacks "-wt-"
const SHARED_PORTS = { api: 54321, db: 54322, smtp: 1025 } as const;

const APPLY = process.argv.includes("--apply");

function log(msg: string): void {
	process.stdout.write(`${msg}\n`);
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Resolve the podman binary (the /opt install isn't on the default PATH). */
function resolvePodman(): string {
	const candidate = "/opt/podman/bin/podman";
	return fs.existsSync(candidate) ? candidate : "podman";
}

function podman(args: string[]): string {
	return execFileSync(resolvePodman(), args, { encoding: "utf8" }).trim();
}

type Worktree = { path: string; isMain: boolean };

function listWorktrees(): Worktree[] {
	// `git worktree list --porcelain` emits a "worktree <path>" line per entry; the first is main.
	const out = execFileSync("git", ["worktree", "list", "--porcelain"], { encoding: "utf8" });
	const paths = out
		.split("\n")
		.filter((l) => l.startsWith("worktree "))
		.map((l) => l.slice("worktree ".length).trim());
	return paths.map((p, i) => ({ path: p, isMain: i === 0 }));
}

function configProjectId(worktreePath: string): string | null {
	const config = path.join(worktreePath, "supabase", "config.toml");
	try {
		const toml = fs.readFileSync(config, "utf8");
		return toml.match(/^\s*project_id\s*=\s*["']([^"']+)["']/m)?.[1] ?? null;
	} catch {
		return null;
	}
}

function isSkipWorktree(worktreePath: string): boolean {
	// `git ls-files -v` tags skip-worktree entries with a leading "S".
	try {
		const out = git(worktreePath, ["ls-files", "-v", "supabase/config.toml"]);
		return out.startsWith("S");
	} catch {
		return false;
	}
}

/**
 * True iff the only differences in config.toml vs HEAD are project_id / port / smtp_port lines —
 * i.e. exactly what the old port-patcher wrote. Anything else means a real local edit we must not
 * clobber. Run AFTER clearing skip-worktree (so the diff is visible).
 */
function onlyPortPatchDiff(worktreePath: string): boolean {
	// Let a git failure THROW — the per-worktree try-catch in main() turns it into a logged
	// "git error, skipping" rather than this masquerading as "user edited config.toml".
	const diff = git(worktreePath, ["diff", "--no-color", "--", "supabase/config.toml"]);
	if (diff === "") return true; // nothing to restore
	const changed = diff
		.split("\n")
		.filter((l) => (l.startsWith("+") || l.startsWith("-")) && !l.startsWith("+++") && !l.startsWith("---"));
	const benign = /(project_id\s*=|^[+-]\s*port\s*=|smtp_port\s*=)/;
	return changed.every((l) => benign.test(l));
}

/** Upsert SUPABASE_URL/DATABASE_URL/EMAIL_SMTP_PORT to the shared defaults, preserving other lines. */
function rewriteEnvPorts(content: string): string {
	const upsert = (text: string, key: string, value: string): string => {
		const line = `${key}=${value}`;
		const pattern = new RegExp(`^${key}=.*$`, "m");
		return pattern.test(text) ? text.replace(pattern, line) : `${text.trimEnd()}\n${line}\n`;
	};
	let next = content;
	next = upsert(next, "SUPABASE_URL", `http://127.0.0.1:${SHARED_PORTS.api}`);
	next = upsert(next, "DATABASE_URL", `postgresql://postgres:postgres@127.0.0.1:${SHARED_PORTS.db}/postgres`);
	next = upsert(next, "EMAIL_SMTP_PORT", String(SHARED_PORTS.smtp));
	return next;
}

function collapseWorktree(wt: Worktree): void {
	const rel = path.basename(wt.path);
	const projectId = configProjectId(wt.path);
	const skip = isSkipWorktree(wt.path);
	const worktreeDir = path.join(wt.path, "supabase", ".worktree");
	const hasSentinel = fs.existsSync(worktreeDir);

	if (projectId === SHARED_PROJECT_ID && !skip && !hasSentinel) {
		log(`  ✓ ${rel}: already on the shared stack — nothing to do`);
		return;
	}

	log(`  • ${rel}: project_id="${projectId}" skip-worktree=${skip} sentinel=${hasSentinel}`);

	// 1. Restore the shared config.toml.
	if (skip || projectId !== SHARED_PROJECT_ID) {
		if (APPLY && skip) git(wt.path, ["update-index", "--no-skip-worktree", "supabase/config.toml"]);
		const safe = APPLY ? onlyPortPatchDiff(wt.path) : true;
		if (!safe) {
			log(
				`    ⚠ ${rel}: supabase/config.toml has edits beyond project_id/ports — leaving it for manual review (skip-worktree cleared).`,
			);
		} else if (APPLY) {
			git(wt.path, ["checkout", "--", "supabase/config.toml"]);
			log(`    → restored supabase/config.toml to the shared default`);
		} else {
			log(`    → would clear skip-worktree + restore supabase/config.toml`);
		}
	}

	// 2. Remove the per-worktree sentinel dir.
	if (hasSentinel) {
		if (APPLY) fs.rmSync(worktreeDir, { recursive: true, force: true });
		log(`    → ${APPLY ? "removed" : "would remove"} supabase/.worktree/`);
	}

	// 3. Repoint .env.local at the shared ports, in place (real files only; a symlink already
	//    points at main, which is correct).
	const envPath = path.join(wt.path, ".env.local");
	try {
		const stat = fs.lstatSync(envPath);
		if (!stat.isSymbolicLink()) {
			const before = fs.readFileSync(envPath, "utf8");
			const after = rewriteEnvPorts(before);
			if (after !== before) {
				if (APPLY) fs.writeFileSync(envPath, after, "utf8");
				log(`    → ${APPLY ? "rewrote" : "would rewrite"} .env.local port lines to the shared stack`);
			}
		}
	} catch {
		// No .env.local in this worktree — nothing to repoint.
	}
}

function teardownPodman(): void {
	let containers: string[] = [];
	let volumes: string[] = [];
	try {
		containers = podman(["ps", "-a", "--format", "{{.Names}}"]).split("\n").filter(Boolean);
		volumes = podman(["volume", "ls", "--format", "{{.Name}}"]).split("\n").filter(Boolean);
	} catch (err) {
		log(`  ⚠ could not query podman (${err instanceof Error ? err.message : String(err)}). Skipping teardown.`);
		log("    If podman is wedged: podman machine stop && podman machine start, then re-run.");
		return;
	}

	const targetContainers = containers.filter((n) => n.includes(WT_MARKER));
	const targetVolumes = volumes.filter((n) => n.includes(WT_MARKER));

	// Defense in depth: every target MUST carry the "-wt-" discriminator. The main stack's
	// resources (…_stocktextalerts) cannot match, but assert it rather than trust the filter.
	for (const name of [...targetContainers, ...targetVolumes]) {
		if (!name.includes(WT_MARKER)) {
			throw new Error(`SAFETY ABORT: teardown target "${name}" lacks "${WT_MARKER}" — refusing.`);
		}
	}

	if (targetContainers.length === 0 && targetVolumes.length === 0) {
		log("  ✓ no stocktextalerts-wt-* podman resources — nothing to tear down");
		return;
	}

	log(`  containers (${targetContainers.length}): ${targetContainers.join(", ") || "—"}`);
	log(`  volumes (${targetVolumes.length}): ${targetVolumes.join(", ") || "—"}`);

	if (!APPLY) {
		log("    → would force-remove the above (containers first, then volumes)");
		return;
	}

	// Containers before volumes — a volume in use by a running container won't remove. Count actual
	// successes so the summary can't claim "all clean" when a destructive rm silently failed.
	let removedContainers = 0;
	let removedVolumes = 0;
	for (const name of targetContainers) {
		try {
			podman(["rm", "-f", name]);
			removedContainers++;
		} catch (err) {
			log(`    ⚠ failed to remove container ${name}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	for (const name of targetVolumes) {
		try {
			podman(["volume", "rm", "-f", name]);
			removedVolumes++;
		} catch (err) {
			log(`    ⚠ failed to remove volume ${name}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	log(
		`    → removed ${removedContainers}/${targetContainers.length} container(s) + ${removedVolumes}/${targetVolumes.length} volume(s)`,
	);
}

function main(): void {
	log(APPLY ? "Collapsing worktrees onto the shared Supabase stack (--apply)\n" : "DRY RUN — pass --apply to execute\n");

	log("Worktrees:");
	for (const wt of listWorktrees()) {
		if (wt.isMain) {
			log(`  · ${path.basename(wt.path)} (main checkout — left as-is)`);
			continue;
		}
		// Isolate each worktree: a broken one (corrupt index, read-only .git, git error) must not
		// abort the run — that would skip the podman teardown below, the migration's whole point.
		try {
			collapseWorktree(wt);
		} catch (err) {
			log(`    ✗ ${path.basename(wt.path)}: ${err instanceof Error ? err.message : String(err)} — skipping`);
		}
	}

	log("\nPodman teardown (allowlist: *stocktextalerts-wt-* only):");
	teardownPodman();

	log(
		APPLY
			? "\nDone. Start the shared stack from any worktree: npm run db:start && npm run db:reset"
			: "\nDry run complete. Re-run with --apply to execute.",
	);
}

main();
