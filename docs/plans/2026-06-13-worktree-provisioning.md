# Worktree Provisioning Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make creating/entering a git worktree for `stocktextalerts` a one-command, fail-closed operation so a fresh worktree never (a) silently lacks gitignored env/seed data, (b) gets a `node_modules` symlink that breaks Vite, or (c) lets a bare `db:reset` wipe the shared/main Supabase seed.

**Architecture:** The DB-side provisioning already exists and is correct — `npm run db:bootstrap` chains `link-worktree-data` (copies gitignored `.env.local` + `scripts/data/users.json` from main) → `worktree-supabase` (isolated per-worktree stack + port-patched `.env.local`) → `db:start` → `db:reset` → `db:doctor`. The failures in the field came from the *workflow never running it* plus `node_modules` having no provisioning path at all. This plan: (1) adds one `worktree:init` command that does deps + `db:bootstrap`; (2) makes `db:reset` and `db:doctor` **fail closed** in an unprovisioned worktree instead of silently hitting the shared stack; (3) fixes the fleet-level sandbox/npm-cache config in `dotagents` so `npm ci` runs in-sandbox; (4) documents the workflow so agents stop hand-hacking.

**Tech Stack:** Node 24, npm (`package-lock.json`, `npm ci`), TypeScript via `tsx`, Vitest, Supabase CLI (Podman), Astro + `@astrojs/vue`, Vite. Two repos: `~/code/stocktextalerts` (app) and `~/code/dotagents` (fleet agent config + Claude sandbox policy).

> **STATUS (2026-06-13, authoritative — read before any task below).**
>
> - **dotagents half (Tasks 1–3 + the block-stray-plans fix) is SHIPPED** to `origin/main` (commits `8efd06b` + `7a847aa`): block-stray-plans worktree carve-out (greedy-bypass fixed), the `~/.npm` ownership doctor check, and the global AGENTS.md worktree nudge. **Task 1 is SUPERSEDED** — the `~/.npm` sandbox grant was tried then reverted; do not re-add it.
> - **npm-cache decision changed** (per the 2026-06-13 deep-research report): the cache-write-in-sandbox problem is solved by **redirecting npm's cache to `$TMPDIR`** in Task 6 (`npm_config_cache`), **not** by a sandbox grant. Run the install **online** (never `--offline`).
> - **Only Tasks 4–7 (stocktextalerts) remain.** Where prose below still says "Task 1 grants `~/.npm`" / "sandbox allows cache writes," read it through this banner: that approach was rejected.

---

## Spec (inline)

Source: a post-mortem of one painful worktree session. Five issues, mapped to root causes:

| # | Symptom | Root cause | Fix |
| --- | --- | --- | --- |
| 1 | Uncommitted plan + gitignored `.env.local` didn't come into the worktree | `EnterWorktree` branches fresh from `origin/main`; gitignored files never copy | Already handled by `link-worktree-data.ts` **once `db:bootstrap` runs**. Fix is to *make it run* (Task 6) + fail closed (Tasks 4–5) + document (Task 7). The uncommitted *plan* file is a workflow issue — commit plans before branching. |
| 2 | `npm install` failed (root-owned `~/.npm`), so `node_modules` was symlinked → Vite `server.fs.allow` 403 on `@astrojs/vue/dist/client.js` → Vue hydration fails → `routes.e2e.spec.ts` fails. Also `.vite-temp` EPERM under the command sandbox. | (a) `~/.npm` root-owned → `npm ci` EACCES; (b) sandbox doesn't permit `~/.npm` cache writes → EPERM; (c) the symlink resolves outside the worktree root, so Vite refuses to serve and writes temp outside `.` | Task 1 (sandbox allows `~/.npm`), Task 2 (detect root-owned `~/.npm`), Task 6 (`worktree:init` does a *real* `npm ci`, never a symlink). Real `node_modules` inside the worktree resolves 2(a/b/c) at once. |
| 3 | `db:reset` in the worktree wiped `test@jsolly.com` from the **shared** local Supabase | Ran `db:reset` *before* `worktree-supabase` created `supabase/.worktree/config.toml`, so `supabaseCliArgs()` returned `[]` → reset hit the default stack (port 54322). `users.json` also wasn't linked yet → 0-user seed. | Task 4: `reset.ts` refuses to run in a linked worktree with no isolated config. Task 6 orders provisioning correctly. |
| 4 | The `node_modules` symlink showed as untracked → tripped the pre-push clean-tree check; had to add it to `.git/info/exclude` | A `node_modules` *symlink* isn't matched by the `node_modules/` (trailing-slash, dirs-only) gitignore pattern | Resolved by Task 6 (real directory install → matches `node_modules/` → ignored). Task 5 fails closed if a symlink is present. |
| 5 | `block-stray-plans` hook false-positive: worktree path contains `.claude/worktrees/…`, so a correctly-placed `docs/plans/…md` was read as a vendor-dir plan and blocked | The guard's `VENDOR_RE` matched the `.claude/` segment in the worktree's absolute path | **DONE this session** in `~/code/dotagents` (`hooks/block-stray-plans.sh` strips the `…/.claude/worktrees/<name>/` prefix; 7 tests added; suite + doctor green). Pending commit only — see "Already done". |

**Acceptance criteria:**

1. From a freshly `git worktree add`-ed checkout, `npm run worktree:init` produces a working worktree: real `node_modules`, linked `.env.local` + `users.json`, isolated Supabase stack, green `db:doctor` — with no manual file copying and no symlinks.
2. `npm run db:reset` in a linked worktree that has **not** been provisioned exits non-zero with an actionable message and does **not** touch the shared stack.
3. `npm run db:doctor` fails (non-zero) in a linked worktree when `node_modules` is a symlink, or when the worktree has no isolated Supabase config, pointing the user at `worktree:init`.
4. `npm ci` runs to completion **inside** the Claude Code command sandbox (no `dangerouslyDisableSandbox`), given a user-owned `~/.npm`.
5. `dotagents` doctor warns (does not hard-fail) when `~/.npm` is not owned by the current user, printing the `chown` fix.
6. The worktree workflow is documented in `stocktextalerts/AGENTS.md` and `docs/local-supabase.md`, and as a general nudge in the `dotagents` global `AGENTS.md`.

**Out of scope / non-goals:**

- Auto-running `worktree:init` on `EnterWorktree` — that tool is native to Claude Code and not hookable here. The fix is a documented one-liner + fail-closed gates, not automation.
- Changing `EnterWorktree`'s "branch fresh from origin/main" behavior.
- The `~/.npm` ownership repair itself is a one-time manual `sudo chown` (Task 2 only *detects* it; a hook can't `sudo`).

**Alternatives considered:**

- *Grant `~/.npm` in the dotagents sandbox* (`sandbox.filesystem.allowWrite`). **Rejected after deep research** (`~/code/dotagents/docs/plans/2026-06-13-remove-sound-hooks.md` era; report 2026-06-13). `~/.npm` is HOME-rooted, shares the npm namespace with the `~/.npmrc` token that supply-chain worms harvest, and — critically — cacache's SHA-512 SRI protects against *accidental* corruption but **not** against an attacker who has write access and rewrites both content and the unsigned integrity index, so a writable cache is a genuine poisoning surface. It also reverses dotagents' 2026-06-11 least-privilege decision. dotagents shipped *without* this grant (commit `7a847aa`). **Chosen instead: redirect npm's cache to `$TMPDIR`** (Task 6) — a first-class npm config knob, sandbox-writable by default, repo-scoped, and effective in-session (a settings.json change only applies next session anyway).
- *`cp -R` node_modules from main* (what the field session ended up doing). Rejected: 1.1 GB copy that drifts from `package-lock.json`. `npm ci` is deterministic and, with the `$TMPDIR` cache, runs in-sandbox without a global grant.

---

## File Structure

**`~/code/dotagents`:**

- Modify `harnesses/claude/settings.json` — add `sandbox.filesystem.allowWrite: ["~/.npm"]` (Task 1).
- Modify `scripts/doctor-agents.sh` — add a `~/.npm` ownership warning (Task 2).
- Modify `AGENTS.md` — add a general "after entering a worktree" nudge (Task 3).
- *(Already modified this session: `hooks/block-stray-plans.sh`, `scripts/test-guards.sh` — the item-5 guard fix.)*

**`~/code/stocktextalerts`:**

- Create `scripts/db/worktree.ts` — single source of truth for worktree detection + the reset-safety policy (Task 4). Removes the duplicated `findMainWorktreeRoot()` now copy-pasted in `link-worktree-data.ts` and `worktree-supabase.ts`.
- Modify `scripts/db/link-worktree-data.ts` and `scripts/db/worktree-supabase.ts` — import `findMainWorktreeRoot` from the new module instead of their local copies (Task 4).
- Modify `scripts/db/reset.ts` — fail closed via the new policy (Task 4).
- Modify `scripts/db/doctor.ts` — early worktree-provisioning + symlinked-`node_modules` checks (Task 5).
- Create `tests/scripts/worktree.test.ts` — unit tests for the pure policy (Tasks 4–5). (Matches existing `tests/scripts/db-start.test.ts`; vitest `include` is `tests/**/*.test.ts`.)
- Modify `package.json` — add the `worktree:init` script (Task 6).
- Modify `AGENTS.md` and `docs/local-supabase.md` — document the workflow + the `node_modules` symlink trap (Task 7).

---

## Already done this session (context, not a task)

The item-5 guard fix is implemented in `~/code/dotagents` working tree, verified (`bash scripts/test-guards.sh` → 219 passed; `bash scripts/doctor-agents.sh --static` → 0 errors) but **not yet committed**. Whoever ships this plan should fold that commit in (or it ships via the normal `dotagents` `/ship`). Files: `hooks/block-stray-plans.sh` (added `strip_worktree_prefix` + `WORKTREE_PREFIX_RE`), `scripts/test-guards.sh` (7 new `checkpath` cases).

---

## Task 1: ~~Sandbox allows `npm` cache writes (dotagents)~~ — SUPERSEDED, do not implement

> **SUPERSEDED by the 2026-06-13 deep-research report.** Do **not** add `sandbox.filesystem.allowWrite: ["~/.npm"]`. The grant was tried, then reverted in dotagents (commit `7a847aa`): a writable `~/.npm` is a HOME-rooted poisoning surface (SRI does not protect a cache from a writer), overlaps the `~/.npmrc` token namespace, and reverses dotagents' least-privilege decision. **The cache-write problem is solved in Task 6 by redirecting npm's cache to `$TMPDIR`** — no dotagents sandbox change. No work to do here; this task remains only as a record of the rejected approach. (The original rationale below is retained for context.)

~~Rationale: `npm run db:*` is already in `excludedCommands` (runs unsandboxed), but `npm ci` / `npm install` are not. They run *in* the sandbox, whose default write policy permits cwd + `$TMPDIR` but not `~/.npm/_cacache`.~~ — see the superseding note: redirect to `$TMPDIR` instead.

- [ ] **Step 1: Add the `allowWrite` key**

In `~/code/dotagents/harnesses/claude/settings.json`, change the `filesystem` block from:

```json
    "filesystem": {
      "denyRead": [
        "~/.ssh",
        "~/.aws",
        "~/.config/gh",
        "~/.config/vercel-plugin",
        "~/.config/gcloud",
        "~/.config/dotagents",
        "~/.supabase",
        "~/.netrc",
        "~/.npmrc"
      ]
    },
```

to:

```json
    "filesystem": {
      "denyRead": [
        "~/.ssh",
        "~/.aws",
        "~/.config/gh",
        "~/.config/vercel-plugin",
        "~/.config/gcloud",
        "~/.config/dotagents",
        "~/.supabase",
        "~/.netrc",
        "~/.npmrc"
      ],
      "allowWrite": [
        "~/.npm"
      ]
    },
```

Note: `~/.npmrc` stays in `denyRead` (it can hold auth tokens); only the `~/.npm` *cache* tree becomes writable. These are different paths and don't conflict.

- [ ] **Step 2: Verify the JSON is valid and the key landed**

Run: `jq '.sandbox.filesystem.allowWrite' ~/code/dotagents/harnesses/claude/settings.json`
Expected: `[ "~/.npm" ]`

- [ ] **Step 3: Apply to the live machine config**

`~/.claude/settings.json` is *copied* (never symlinked) from the harness file, so re-run the installer:

Run: `bash ~/code/dotagents/scripts/install-local-agent-runtime.sh`
Then: `jq '.sandbox.filesystem.allowWrite' ~/.claude/settings.json`
Expected: `[ "~/.npm" ]`

- [ ] **Step 4: Confirm doctor parity still green**

Run: `bash ~/code/dotagents/scripts/doctor-agents.sh --static`
Expected: `doctor-agents: 0 error(s), 0 warning(s)`

- [ ] **Step 5: Commit (in dotagents)**

```bash
cd ~/code/dotagents
git add harnesses/claude/settings.json
git commit -m "feat(claude): allow ~/.npm cache writes in the command sandbox"
```

---

## Task 2: dotagents doctor warns on root-owned `~/.npm` (dotagents)

**Files:**

- Modify: `~/code/dotagents/scripts/doctor-agents.sh` (add one check in the live, non-`--static` section)

Rationale: even with Task 1, a root-owned `~/.npm` (from a past `sudo npm`) makes `npm ci` EACCES. A hook can't `sudo`, so the doctor *detects* it and prints the one-time fix. This is a **warning**, not an error (it's machine state, orthogonal to the guard-parity invariants), and lives in the live section since it touches `$HOME`.

- [ ] **Step 1: Read the doctor to find the live section + its `warn`/`ok` helpers**

Run: `grep -nE "static|warn\(|ok:|HOME|^# ---|live" ~/code/dotagents/scripts/doctor-agents.sh | head -40`
Expected: shows the static/live split and the existing `warn`/`ok` output helpers. Use the same helper names the script already defines (do **not** invent new ones).

- [ ] **Step 2: Add the check in the live section**

In the live (non-`--static`) section, after the existing `~/` drift checks, add (adapt the `warn`/`ok` call to the script's actual helper names found in Step 1):

```bash
# ~/.npm cache must be owned by the current user or `npm ci` fails EACCES (and a
# root-owned cache is what drove the worktree node_modules-symlink workaround).
npm_cache="$HOME/.npm"
if [[ -d "$npm_cache" ]]; then
  owner_uid="$(stat -f '%u' "$npm_cache" 2>/dev/null || stat -c '%u' "$npm_cache" 2>/dev/null || echo "")"
  if [[ -n "$owner_uid" && "$owner_uid" != "$(id -u)" ]]; then
    warn "~/.npm is owned by uid $owner_uid, not you ($(id -u)) — npm ci will EACCES. Fix: sudo chown -R $(id -u):$(id -g) ~/.npm"
  else
    ok "~/.npm owned by current user"
  fi
fi
```

(`stat -f` is macOS/BSD, `stat -c` is GNU — the fallback chain handles both. This repo targets a macOS laptop but keep the fallback.)

- [ ] **Step 3: Run the full doctor and confirm it reports the check**

Run: `bash ~/code/dotagents/scripts/doctor-agents.sh 2>&1 | grep -i "\.npm"`
Expected: either `ok: ~/.npm owned by current user` (healthy machine) or the `warn:` line with the `chown` fix. Either is correct; the point is the check ran.

- [ ] **Step 4: Confirm `--static` is unaffected (must never touch `$HOME`)**

Run: `bash ~/code/dotagents/scripts/doctor-agents.sh --static 2>&1 | grep -ci "\.npm" || true`
Expected: `0` (the new check is live-only).

- [ ] **Step 5: Commit (in dotagents)**

```bash
cd ~/code/dotagents
git add scripts/doctor-agents.sh
git commit -m "feat(doctor): warn when ~/.npm is not owned by the current user"
```

---

## Task 3: Global worktree nudge in dotagents AGENTS.md (dotagents)

**Files:**

- Modify: `~/code/dotagents/AGENTS.md` (the global brief — under the existing worktree-adjacent guidance near "No self-initiated branches")

Rationale: `AGENTS.md` is the global brief loaded into every session on every machine. A short, repo-agnostic rule stops agents from hand-copying files / symlinking `node_modules` after `EnterWorktree`. App-specific commands stay in the app repo's `AGENTS.md` (Task 7).

- [ ] **Step 1: Read the surrounding lines to match tone/format**

Run: `grep -n "No self-initiated branches\|Worktrees are not gated" ~/code/dotagents/AGENTS.md`
Expected: locates the existing worktree sentence (~line 23) to append after.

- [ ] **Step 2: Add the nudge**

Immediately after the "Worktrees are not gated." sentence, add:

```markdown
- **After entering a worktree, provision it before doing anything else.** A fresh worktree branches from `origin/main` and does **not** carry gitignored files (`.env.local`, local seed data) or `node_modules`. If the repo has a worktree-setup command (e.g. `npm run worktree:init`), run it first. **Never symlink `node_modules`** into a worktree — it resolves outside the worktree root and breaks dev servers that restrict file serving (e.g. Vite `server.fs.allow`); do a real install instead.
```

- [ ] **Step 3: Lint**

Run: `bash ~/code/dotagents/scripts/lint-md.sh`
Expected: no errors for `AGENTS.md` (run with `--fix` if a trivial formatting nit appears, then re-run).

- [ ] **Step 4: Commit (in dotagents)**

```bash
cd ~/code/dotagents
git add AGENTS.md
git commit -m "docs(agents): require worktree provisioning, forbid node_modules symlinks"
```

---

## Task 4: Shared worktree helper + fail-closed `db:reset` (stocktextalerts)

**Files:**

- Create: `~/code/stocktextalerts/scripts/db/worktree.ts`
- Create: `~/code/stocktextalerts/tests/scripts/worktree.test.ts`
- Modify: `~/code/stocktextalerts/scripts/db/reset.ts` (top of `main()`)
- Modify: `~/code/stocktextalerts/scripts/db/link-worktree-data.ts:36-61` (replace local `findMainWorktreeRoot` with an import)
- Modify: `~/code/stocktextalerts/scripts/db/worktree-supabase.ts:48-70` (replace local `findMainWorktreeRoot` with an import)

Rationale: worktree detection is currently copy-pasted in two scripts; the reset guard needs a third use. Extract once (DRY, per `rules/code-style.md`). The dangerous-reset decision is a **pure** function so it's trivially unit-tested without git/fs state.

- [ ] **Step 1: Write the failing test**

Create `~/code/stocktextalerts/tests/scripts/worktree.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { unsafeResetMessage } from "../../scripts/db/worktree";

describe("unsafeResetMessage", () => {
 it("refuses reset in a linked worktree with no isolated config", () => {
  const msg = unsafeResetMessage(true, false);
  expect(msg).not.toBeNull();
  expect(msg).toContain("worktree:init");
 });

 it("allows reset in a provisioned worktree (isolated config present)", () => {
  expect(unsafeResetMessage(true, true)).toBeNull();
 });

 it("allows reset in the main worktree (not linked)", () => {
  expect(unsafeResetMessage(false, false)).toBeNull();
  expect(unsafeResetMessage(false, true)).toBeNull();
 });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/code/stocktextalerts && npm test -- tests/scripts/worktree.test.ts`
Expected: FAIL — cannot resolve `../../scripts/db/worktree` (module doesn't exist yet).

- [ ] **Step 3: Create the helper module**

Create `~/code/stocktextalerts/scripts/db/worktree.ts`:

```ts
/**
 * scripts/db/worktree.ts — single source of truth for git-worktree detection and
 * the local-Supabase reset-safety policy. Extracted from the copies that used to
 * live in link-worktree-data.ts and worktree-supabase.ts.
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
 // In a linked worktree git-dir is .git/worktrees/<name>/ while common-dir is the
 // main repo's .git/. Equal ⇒ this IS the main checkout.
 if (absoluteGitDir === absoluteCommonDir) return null;
 return path.dirname(absoluteCommonDir);
}

export function isLinkedWorktree(): boolean {
 return findMainWorktreeRoot() !== null;
}

/**
 * Pure policy: the refusal message when running `db:reset` would be unsafe, else null.
 *
 * Unsafe iff we're in a linked worktree that has NOT been given its own isolated
 * Supabase stack — `supabaseCliArgs()` would then return [] and the reset would
 * target the shared/main stack (port 54322) and wipe its seed.
 */
export function unsafeResetMessage(
 linkedWorktree: boolean,
 hasIsolatedConfig: boolean,
): string | null {
 if (linkedWorktree && !hasIsolatedConfig) {
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd ~/code/stocktextalerts && npm test -- tests/scripts/worktree.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire the guard into `reset.ts`**

In `~/code/stocktextalerts/scripts/db/reset.ts`, add to the imports:

```ts
import { worktreeSupabaseConfigPath } from "./supabase-cli-args";
import { isLinkedWorktree, unsafeResetMessage } from "./worktree";
```

Then make `main()` fail closed *before* it runs anything (insert as the first statements in `main()`, above `const supabaseArgs = supabaseCliArgs();`):

```ts
 const refusal = unsafeResetMessage(isLinkedWorktree(), worktreeSupabaseConfigPath() !== null);
 if (refusal !== null) {
  process.stderr.write(`${refusal}\n`);
  process.exit(1);
 }
```

(`worktreeSupabaseConfigPath()` already exists in `supabase-cli-args.ts` and returns `null` when `supabase/.worktree/config.toml` is absent.)

- [ ] **Step 6: De-duplicate — point the two existing scripts at the shared helper**

In `scripts/db/link-worktree-data.ts`: delete its local `findMainWorktreeRoot` (lines ~36-61) and add `import { findMainWorktreeRoot } from "./worktree";` (drop the now-unused `execFileSync` import if nothing else uses it).

In `scripts/db/worktree-supabase.ts`: delete its local `findMainWorktreeRoot` (lines ~48-70) and add `import { findMainWorktreeRoot } from "./worktree";` (keep `execFileSync` there — `worktreeSlug()` still uses it).

- [ ] **Step 7: Verify nothing regressed (typecheck + unused-export scan + the script tests)**

Run: `cd ~/code/stocktextalerts && npm run check:ts && npm run check:knip && npm test -- tests/scripts/`
Expected: typecheck passes; knip reports no new unused exports/files; existing `tests/scripts/db-start.test.ts` + the new `worktree.test.ts` pass.

- [ ] **Step 8: Manual safety check — reset refuses in an unprovisioned worktree**

Run (in a throwaway linked worktree with **no** `supabase/.worktree/config.toml`): `npm run db:reset`
Expected: exits non-zero, prints the "db:reset refused" message, and the shared stack's `auth.users` is untouched. (Skip if you don't have a spare worktree handy; the unit test in Step 4 covers the policy.)

- [ ] **Step 9: Commit (in stocktextalerts)**

```bash
cd ~/code/stocktextalerts
git add scripts/db/worktree.ts scripts/db/reset.ts scripts/db/link-worktree-data.ts scripts/db/worktree-supabase.ts tests/scripts/worktree.test.ts
git commit -m "feat(db): fail closed on db:reset in an unprovisioned worktree"
```

---

## Task 5: `db:doctor` early worktree checks (stocktextalerts)

**Files:**

- Modify: `~/code/stocktextalerts/scripts/db/doctor.ts` (add early checks in `main()`, before the SUPABASE_URL/auth checks)
- Modify: `~/code/stocktextalerts/tests/scripts/worktree.test.ts` (add tests for the two new pure checks)

Rationale: `db:doctor` runs via `predev`/`pretest`, so it's the natural place to catch a half-provisioned worktree *early* with an actionable hint — before the cryptic downstream failures (Vite 403, `tsx not found`). Today, in an unprovisioned worktree `readSeedEmails()` returns `[]` and doctor passes green (false all-clear); these checks close that. Keep the new checks **pure + unit-tested**; `main()` just feeds them real fs/git state.

- [ ] **Step 1: Write failing tests for the two new pure checks**

Append to `~/code/stocktextalerts/tests/scripts/worktree.test.ts`:

```ts
import { symlinkedNodeModulesMessage, unprovisionedWorktreeMessage } from "../../scripts/db/worktree";

describe("symlinkedNodeModulesMessage", () => {
 it("flags a symlinked node_modules", () => {
  const msg = symlinkedNodeModulesMessage(true);
  expect(msg).not.toBeNull();
  expect(msg).toContain("symlink");
 });
 it("allows a real node_modules directory", () => {
  expect(symlinkedNodeModulesMessage(false)).toBeNull();
 });
});

describe("unprovisionedWorktreeMessage", () => {
 it("flags a linked worktree with no isolated config", () => {
  const msg = unprovisionedWorktreeMessage(true, false);
  expect(msg).not.toBeNull();
  expect(msg).toContain("worktree:init");
 });
 it("allows a provisioned or main worktree", () => {
  expect(unprovisionedWorktreeMessage(true, true)).toBeNull();
  expect(unprovisionedWorktreeMessage(false, false)).toBeNull();
 });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ~/code/stocktextalerts && npm test -- tests/scripts/worktree.test.ts`
Expected: FAIL — `symlinkedNodeModulesMessage` / `unprovisionedWorktreeMessage` are not exported.

- [ ] **Step 3: Add the two pure helpers to `scripts/db/worktree.ts`**

```ts
/** Refusal message when node_modules is a symlink (breaks Vite server.fs.allow), else null. */
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

/** Hint when in a linked worktree with no isolated Supabase stack, else null. */
export function unprovisionedWorktreeMessage(
 linkedWorktree: boolean,
 hasIsolatedConfig: boolean,
): string | null {
 if (linkedWorktree && !hasIsolatedConfig) {
  return [
   "",
   "✋ This linked worktree has no isolated Supabase stack — it is not provisioned.",
   "   Run:  npm run worktree:init",
   "",
  ].join("\n");
 }
 return null;
}
```

- [ ] **Step 4: Run to verify the new tests pass**

Run: `cd ~/code/stocktextalerts && npm test -- tests/scripts/worktree.test.ts`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Wire the checks into `doctor.ts`**

In `~/code/stocktextalerts/scripts/db/doctor.ts`, add imports:

```ts
import { worktreeSupabaseConfigPath } from "./supabase-cli-args";
import { isLinkedWorktree, symlinkedNodeModulesMessage, unprovisionedWorktreeMessage } from "./worktree";
```

At the very top of `main()` (before `const supabaseUrl = process.env.SUPABASE_URL;`), add:

```ts
 // Worktree provisioning preflight — fail early with an actionable hint rather than
 // letting the missing pieces surface as a Vite 403 or a confusing seed-missing error.
 const nmPath = path.join(projectRoot, "node_modules");
 const nmIsSymlink = fs.existsSync(nmPath) && fs.lstatSync(nmPath).isSymbolicLink();
 const provisioningError =
  symlinkedNodeModulesMessage(nmIsSymlink) ??
  unprovisionedWorktreeMessage(isLinkedWorktree(), worktreeSupabaseConfigPath() !== null);
 if (provisioningError !== null) {
  rootLogger.error("db:doctor — worktree not provisioned", { action: "db_doctor" });
  process.stderr.write(`${provisioningError}\n`);
  process.exitCode = 1;
  return;
 }
```

(`fs`, `path`, `projectRoot`, and `rootLogger` are already imported/defined in `doctor.ts`.)

- [ ] **Step 6: Verify doctor still passes on the healthy main checkout**

Run: `cd ~/code/stocktextalerts && npm run db:start && npm run db:doctor`
Expected: exit 0, `db:doctor — ok (auth reachable; seed users present)`. (Main checkout: not a linked worktree, real `node_modules` → both new checks no-op.)

- [ ] **Step 7: Typecheck + knip**

Run: `cd ~/code/stocktextalerts && npm run check:ts && npm run check:knip`
Expected: pass; no new unused exports.

- [ ] **Step 8: Commit (in stocktextalerts)**

```bash
cd ~/code/stocktextalerts
git add scripts/db/worktree.ts scripts/db/doctor.ts tests/scripts/worktree.test.ts
git commit -m "feat(db): db:doctor catches symlinked node_modules and unprovisioned worktrees"
```

---

## Task 6: `worktree:init` one-command provisioning (stocktextalerts)

**Files:**

- Modify: `~/code/stocktextalerts/package.json` (the `scripts` block)

Rationale: collapse the whole "fresh worktree → working dev env" flow into one command: real `npm ci` (deps, never a symlink) then the existing `db:bootstrap` (linked data + isolated stack + reset + doctor). `npm ci` works without an existing `node_modules` (npm itself is global), and after it runs, `db:bootstrap`'s `./node_modules/.bin/tsx` calls resolve.

**npm cache (per the 2026-06-13 research — supersedes Task 1):** `npm ci` writes a content-addressable cache to `~/.npm/_cacache` by default, which the command sandbox blocks (writes are limited to cwd + `$TMPDIR`). Instead of granting `~/.npm` (rejected — see Task 1), redirect the cache to the already-sandbox-writable `$TMPDIR` with `--cache`. **Run online — never `--offline`/`--prefer-offline`:** a cold `$TMPDIR` cache + offline mode hard-fails (`ENOTCACHED`/`ETARGET`, npm/cli#6367) instead of refetching; a plain online `npm ci` treats a cache miss as a network fetch. The cold-cache cost is a one-time fetch per worktree (unmeasured — time it empirically; all published benchmarks were blog-grade and refuted in the research).

- [ ] **Step 1: Add the script**

In `~/code/stocktextalerts/package.json` `scripts`, add (next to the other `db:`/worktree entries, e.g. after `db:worktree-setup`). The `npm_config_cache` env form keeps the redirect with the install even though `db:bootstrap` shells out to further npm/tsx calls:

```json
  "worktree:init": "npm_config_cache=\"${TMPDIR:-/tmp}/stocktextalerts-npm-cache\" npm ci && npm run db:bootstrap",
```

(Equivalent to `npm ci --cache="$TMPDIR/.npm-cache"` for the install step; the env-var form is shell-portable inside the JSON string. `db:bootstrap` itself runs `npm run db:*`, which is in dotagents' `excludedCommands` and so executes unsandboxed — its npm cache writes are unaffected either way.)

- [ ] **Step 2: Validate JSON + script registration**

Run: `cd ~/code/stocktextalerts && node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))" && npm run | grep worktree:init`
Expected: no JSON error; `worktree:init` listed.

- [ ] **Step 3: End-to-end on a real fresh worktree**

```bash
cd ~/code/stocktextalerts
git worktree add .claude/worktrees/wt-provisioning-smoke -b wt-provisioning-smoke
cd .claude/worktrees/wt-provisioning-smoke
npm run worktree:init
```

Expected, in order: `npm ci` completes **inside the sandbox** (no `dangerouslyDisableSandbox`) into a real `node_modules/` directory (verify: `test -d node_modules && ! test -L node_modules && echo OK`); `db:bootstrap` links `.env.local` + `scripts/data/users.json`, writes `supabase/.worktree/config.toml`, starts the isolated stack, reseeds, and ends with `db:doctor — ok`. The shared/main stack is untouched.

- [ ] **Step 4: Confirm the worktree is clean (item 4 regression)**

Run (from the smoke worktree): `git status --porcelain`
Expected: empty — no untracked `node_modules` (a real directory matches the `node_modules/` gitignore; a symlink would not). No need to touch `.git/info/exclude`.

- [ ] **Step 5: Tear down the smoke worktree**

```bash
cd ~/code/stocktextalerts/.claude/worktrees/wt-provisioning-smoke
supabase stop --config supabase/.worktree/config.toml
cd ~/code/stocktextalerts
git worktree remove .claude/worktrees/wt-provisioning-smoke --force
git branch -D wt-provisioning-smoke
```

Expected: worktree + branch gone; `git worktree list` shows only the main checkout (and any pre-existing worktrees).

- [ ] **Step 6: Commit (in stocktextalerts)**

```bash
cd ~/code/stocktextalerts
git add package.json
git commit -m "feat(worktree): add worktree:init (npm ci + db:bootstrap)"
```

---

## Task 7: Document the workflow (stocktextalerts)

**Files:**

- Modify: `~/code/stocktextalerts/AGENTS.md` (Commands block + a short "Worktrees" note)
- Modify: `~/code/stocktextalerts/docs/local-supabase.md` ("Linked worktree isolation" section)

- [ ] **Step 1: Add `worktree:init` to the AGENTS.md Commands block**

In `~/code/stocktextalerts/AGENTS.md`, in the ```bash command list, add directly above the `db:bootstrap` line:

```bash
npm run worktree:init     # FIRST thing in a fresh worktree: npm ci + db:bootstrap (deps + linked data + isolated Supabase)
```

- [ ] **Step 2: Add a short "Worktrees" subsection to AGENTS.md**

After the "Test concurrency lock" bullet (~line 76), add:

```markdown
- **Fresh worktree?** Run `npm run worktree:init` before anything else. A new worktree branches from `origin/main` and lacks gitignored `.env.local` + `scripts/data/users.json` and `node_modules`. `worktree:init` does a real `npm ci` and `db:bootstrap` (linked data + an **isolated** local Supabase stack on its own ports). **Never symlink `node_modules`** — it resolves outside the worktree root and Vite's `server.fs.allow` then 403s on `@astrojs/vue/dist/client.js`, breaking Vue-island hydration and `tests/e2e/routes.e2e.spec.ts`. `db:reset` and `db:doctor` now fail closed if the worktree isn't provisioned. Tear down with `supabase stop --config supabase/.worktree/config.toml` before `git worktree remove`.
```

- [ ] **Step 3: Expand the docs/local-supabase.md worktree section**

In `~/code/stocktextalerts/docs/local-supabase.md`, under "Linked worktree isolation", after the existing "Re-run `npm run db:bootstrap` …" paragraph, add:

```markdown
**One command:** `npm run worktree:init` = `npm ci` + `db:bootstrap`. Use it as the first step in any fresh worktree — it provisions dependencies *and* the isolated stack in the right order.

**Never symlink `node_modules` into a worktree.** A symlink resolves to the main repo's path, outside the worktree root, so Vite's `server.fs.allow` refuses to serve `@astrojs/vue/dist/client.js` over `/@fs/` (403 → Vue islands don't hydrate → `routes.e2e.spec.ts` fails), and a symlinked `node_modules` shows up as untracked (the `node_modules/` gitignore matches directories, not symlinks). Always `npm ci` for a real directory.

**If `npm ci` fails with EACCES on `~/.npm`:** the npm cache is root-owned (a past `sudo npm`). Fix once: `sudo chown -R $(id -u):$(id -g) ~/.npm`. (`dotagents`' `doctor-agents.sh` warns about this.) Under the Claude Code command sandbox, `~/.npm` is writable via `sandbox.filesystem.allowWrite` in the dotagents Claude harness; if you must work around it ad hoc, redirect the cache with `npm ci --cache="$TMPDIR/.npm-cache"`.

**`db:reset` / `db:doctor` are fail-closed in worktrees:** both refuse (non-zero) in a linked worktree that hasn't been provisioned, so a bare `db:reset` can no longer wipe the shared/main seed. Run `npm run worktree:init` first.
```

- [ ] **Step 4: Lint the docs**

Run: `cd ~/code/stocktextalerts && npx markdownlint-cli2 AGENTS.md docs/local-supabase.md` (or the repo's documented md-lint command if different)
Expected: no errors (fix trivial nits and re-run).

- [ ] **Step 5: Commit (in stocktextalerts)**

```bash
cd ~/code/stocktextalerts
git add AGENTS.md docs/local-supabase.md
git commit -m "docs: document worktree:init, the node_modules symlink trap, and fail-closed db gates"
```

---

## Self-Review

**1. Spec coverage:**

- Issue 1 (gitignored files) → Tasks 6 (`worktree:init` runs `link-worktree-data` via bootstrap) + 4/5 (fail closed) + 7 (docs). ✅
- Issue 2 (node_modules symlink / Vite 403 / `.vite-temp` EPERM / npm install fail) → Tasks 1 (sandbox `~/.npm`) + 2 (chown detect) + 6 (real `npm ci`) + 7 (trap doc). ✅
- Issue 3 (shared-DB seed wipe) → Task 4 (reset fail-closed) + 6 (correct ordering). ✅
- Issue 4 (untracked symlink trips clean-tree) → Task 6 Step 4 (real dir → ignored) + Task 5 (symlink detection). ✅
- Issue 5 (block-stray-plans false-positive) → done this session; recorded under "Already done". ✅
- Acceptance criteria 1–6 each map to Tasks 6, 4, 5, 1, 2, 7 respectively. ✅

**2. Placeholder scan:** No "TBD"/"add error handling"/"similar to Task N". Two intentional, justified soft spots: Task 2 Step 1 asks the implementer to match the doctor's *actual* `warn`/`ok` helper names (the script's API isn't reproduced here) and Task 7 Step 4 allows the repo's documented md-lint command — both are "discover the local convention," not missing content.

**3. Type consistency:** `findMainWorktreeRoot()`, `isLinkedWorktree()`, `unsafeResetMessage(linkedWorktree, hasIsolatedConfig)`, `symlinkedNodeModulesMessage(nodeModulesIsSymlink)`, `unprovisionedWorktreeMessage(linkedWorktree, hasIsolatedConfig)` are defined in Task 4/5's `worktree.ts` and consumed with matching signatures in `reset.ts` and `doctor.ts`. `worktreeSupabaseConfigPath()` is the pre-existing export from `supabase-cli-args.ts` (returns `string | null`), used as `… !== null`. Consistent. ✅

**Cross-repo note:** Tasks 1–3 are in `~/code/dotagents`; Tasks 4–7 are in `~/code/stocktextalerts`. Each task's commands `cd` into the right repo. The dotagents changes (Tasks 1–3 + the already-done guard fix) can ship via dotagents' own `/ship`; the stocktextalerts changes via its pre-push gate.
