# Worktree Supabase Isolation — Migrate Off the Removed `--config` Flag (CLI 2.105.0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.
>
> **DECISION REQUIRED before Task 0 implementation** — the mechanism (skip-worktree vs config-template) is laid out in the Spec. Steps below are written for the **recommended skip-worktree approach**; get sign-off (or switch) before executing.

**Goal:** Restore per-worktree local Supabase isolation under Supabase CLI ≥ 2.105.0, which removed the `--config <file>` flag the current design depends on. This is the **prerequisite** that unblocks (a) the in-flight `toggle-state-desync` worktree's DB tests and (b) worktree-provisioning Tasks 4–7 (`docs/plans/2026-06-13-worktree-provisioning.md`).

**Architecture:** Today, `scripts/db/worktree-supabase.ts` writes an *overlay* config to `supabase/.worktree/config.toml` and `scripts/db/supabase-cli-args.ts` injects `--config <that file>` into every supabase command. CLI 2.105.0 has only `--workdir <project-dir>` (no `--config`), so `db:start`/`db:reset` fail in every isolated worktree. The fix: stop using a separate overlay file + flag. Instead, write the isolated `project_id` + ports **directly into the worktree's own `supabase/config.toml`** (each worktree is its own checkout) using the already-present `smol-toml` parser, and `git update-index --skip-worktree` it so the local edit never appears as a diff or gets committed. Supabase then reads the isolated config with **no CLI flag**, and `supabaseCliArgs()` is deleted. A gitignored `supabase/.worktree/meta.json` sentinel remains as the "is this worktree provisioned?" marker for the fail-closed guards.

**Tech Stack:** Node 24, TypeScript via `tsx`, `smol-toml` (already a dependency), Supabase CLI 2.105.0 (Podman), Vitest. Repo: `~/code/stocktextalerts`.

---

## Spec (inline)

**Problem.** `supabase --version` → `2.105.0`. `supabase start --help` lists only `--workdir string` ("Path to a Supabase project directory"); there is no `--config`. `scripts/db/supabase-cli-args.ts:11-16` returns `["--config", "<repo>/supabase/.worktree/config.toml"]` whenever that file exists, and `reset.ts:27` + `start.ts:58` pass it to the CLI → unknown-flag failure → `db:start`/`db:reset`/`db:bootstrap` all fail inside any linked worktree.

**Why it's not a flag rename.** `--config` named a specific config *file* at an arbitrary path. `--workdir` names a *directory* under which the CLI expects `supabase/config.toml`. The current overlay-file design (a second `config.toml` living at `supabase/.worktree/`) has no clean `--workdir` mapping — pointing `--workdir` at `supabase/.worktree/` would make the CLI look for `supabase/.worktree/supabase/config.toml` and lose the migrations/seed tree. The isolation mechanism must change.

**Secondary defect found while scoping.** `worktree-supabase.ts:writeWorktreeConfig()` builds the overlay by *appending* `[api]`/`[db]`/`[studio]`/`[inbucket]` tables after the full base `config.toml`, which already contains `[db]`, `[studio]`, `[inbucket]`. That's **duplicate TOML tables** — invalid TOML. The migration must produce valid TOML (set keys in their existing tables), which `smol-toml` makes straightforward.

**Options considered:**

| Option | Mechanism | Verdict |
| --- | --- | --- |
| **A. skip-worktree (recommended)** | Parse the worktree's own `supabase/config.toml` with `smol-toml`, set `project_id` + ports in-place, serialize, write back, `git update-index --skip-worktree supabase/config.toml`. No CLI flag anywhere. | **Chosen.** Surgical, worktree-scoped (each worktree has its own index, so the bit doesn't leak to main), uses an existing dep, no new files for the CLI to find. Cost: a skip-worktree'd `config.toml` won't pick up upstream `config.toml` changes on pull/merge in that worktree — acceptable for short-lived worktrees; documented. |
| B. config-template | Gitignore `config.toml`, track `config.toml.template`, render per-checkout (with ports) at `db:start`. | Cleaner conceptual separation, but invasive: **every** checkout incl. main + CI + any tool reading `config.toml` now depends on a render step; larger blast radius. Defer unless A proves unworkable. |
| C. drop isolation | Remove per-worktree stacks; all worktrees share main's stack. | Rejected: reintroduces the seed-wipe (worktree-provisioning issue #3). With the fail-closed `db:reset` guard, worktrees couldn't reset at all → no DB testing in worktrees. |

**Acceptance criteria:**

1. In a linked worktree, `npm run db:start` and `npm run db:reset` succeed against an **isolated** stack (distinct `project_id` + ports) with **no `--config`/`--workdir` flag** and no unknown-flag error.
2. `git status` in the worktree shows **no** modification to `supabase/config.toml` after provisioning (skip-worktree hides the local edit).
3. The main checkout's stack and seed are **untouched** when a worktree runs `db:reset`.
4. The worktree's `config.toml` is **valid TOML** (parses via `smol-toml`; no duplicate tables).
5. `supabaseCliArgs()` is gone; no caller references `--config`.
6. A provisioned-worktree sentinel (`supabase/.worktree/meta.json`) still exists for the fail-closed guards in worktree-provisioning Tasks 4–5 to detect.
7. The `toggle-state-desync` worktree can run `npm test` / `npm run db:reset` after re-provisioning.

**Non-goals:** Changing main-checkout behavior; the node_modules/`$TMPDIR` provisioning (that's worktree-provisioning Task 6); auto-running provisioning on `EnterWorktree`.

---

## File Structure

- Modify `scripts/db/worktree-supabase.ts` — replace `writeWorktreeConfig()` (overlay-file + append) with in-place `smol-toml` edits to the worktree's `supabase/config.toml` + `git update-index --skip-worktree`; keep writing `supabase/.worktree/meta.json` as the provisioned sentinel; drop `BASE_CONFIG`/`WORKTREE_CONFIG` overlay paths.
- Rewrite/delete `scripts/db/supabase-cli-args.ts` — `supabaseCliArgs()` removed; keep a `worktreeProvisioned()` / `worktreeMetaPath()` helper keyed on `supabase/.worktree/meta.json` for the guards.
- Modify `scripts/db/reset.ts:10,27` and `scripts/db/start.ts:17,58` — drop the `supabaseArgs`/`configArgs` spreads (supabase now reads the worktree's own config.toml directly).
- Create `tests/scripts/worktree-supabase.test.ts` — unit-test the pure TOML-rewrite function (parse base → set project_id + ports → serialize → re-parse asserts).
- Verify `supabase/.worktree/` stays gitignored (it already should be — confirm in Task 0.1 Step 1).

---

## Task 0.1: Rewrite the worktree config writer to edit `config.toml` in-place (valid TOML)

**Files:**

- Modify: `scripts/db/worktree-supabase.ts`
- Create: `tests/scripts/worktree-supabase.test.ts`

- [ ] **Step 1: Confirm `.worktree/` is gitignored and read the current writer**

Run: `cd ~/code/stocktextalerts && git check-ignore supabase/.worktree/x && grep -n "worktree" .gitignore`
Expected: `supabase/.worktree/` is ignored (so `meta.json` never commits). If not, add `supabase/.worktree/` to `.gitignore` as Step 1a.
Then re-read `scripts/db/worktree-supabase.ts` (the `BASE_PORTS`, `portsForSlug`, `writeWorktreeConfig`, `materializeEnvLocal`, `ensureWorktreeSupabaseConfig` functions) — the port-derivation and `.env.local` materialization logic is correct and stays; only the config-*writing* changes.

- [ ] **Step 2: Write the failing test for the pure TOML rewrite**

Create `tests/scripts/worktree-supabase.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parse } from "smol-toml";

import { applyWorktreePorts } from "../../scripts/db/worktree-supabase";

const BASE = `project_id = "stocktextalerts"

[api]
port = 54321

[db]
port = 54322

[studio]
port = 54323

[inbucket]
port = 54324
smtp_port = 1025
`;

describe("applyWorktreePorts", () => {
 it("sets project_id and ports in-place, producing valid TOML with no duplicate tables", () => {
  const out = applyWorktreePorts(BASE, {
   projectId: "stocktextalerts-wt-feat",
   ports: { api: 54331, db: 54332, studio: 54333, inbucket: 54334, smtp: 1026 },
  });
  const parsed = parse(out) as Record<string, any>;
  expect(parsed.project_id).toBe("stocktextalerts-wt-feat");
  expect(parsed.api.port).toBe(54331);
  expect(parsed.db.port).toBe(54332);
  expect(parsed.studio.port).toBe(54333);
  expect(parsed.inbucket.port).toBe(54334);
  expect(parsed.inbucket.smtp_port).toBe(1026);
  // no duplicate-table corruption: a second parse of the same string is stable
  expect(parse(out)).toEqual(parsed);
 });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd ~/code/stocktextalerts && npx vitest run tests/scripts/worktree-supabase.test.ts`
Expected: FAIL — `applyWorktreePorts` is not exported. (Use `npx vitest run` to bypass the `pretest`→`db:doctor` hook, which is irrelevant to a pure-function test.)

- [ ] **Step 4: Implement `applyWorktreePorts` with `smol-toml`**

In `scripts/db/worktree-supabase.ts`, add:

```ts
import { parse, stringify } from "smol-toml";

/** Pure: return `baseToml` with project_id + the five local ports overwritten in-place. */
export function applyWorktreePorts(
 baseToml: string,
 meta: { projectId: string; ports: WorktreePorts },
): string {
 const cfg = parse(baseToml) as Record<string, any>;
 cfg.project_id = meta.projectId;
 cfg.api = { ...(cfg.api ?? {}), port: meta.ports.api };
 cfg.db = { ...(cfg.db ?? {}), port: meta.ports.db };
 cfg.studio = { ...(cfg.studio ?? {}), port: meta.ports.studio };
 cfg.inbucket = { ...(cfg.inbucket ?? {}), port: meta.ports.inbucket, smtp_port: meta.ports.smtp };
 return stringify(cfg);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd ~/code/stocktextalerts && npx vitest run tests/scripts/worktree-supabase.test.ts`
Expected: PASS.

- [ ] **Step 6: Rewire `ensureWorktreeSupabaseConfig` to write the worktree's own config.toml + skip-worktree**

Replace `writeWorktreeConfig(meta)` usage so it: reads the worktree's `supabase/config.toml`, runs `applyWorktreePorts`, writes the result back to that same file, then marks it skip-worktree and writes the sentinel:

```ts
import { execFileSync } from "node:child_process"; // already imported

function writeWorktreeConfig(meta: WorktreeMeta): void {
 const configPath = path.join(projectRoot, "supabase", "config.toml");
 const base = fs.readFileSync(configPath, "utf8");
 fs.writeFileSync(configPath, applyWorktreePorts(base, meta), "utf8");
 // Hide the local port edit from git so config.toml never shows as modified / gets committed.
 execFileSync("git", ["update-index", "--skip-worktree", "supabase/config.toml"], { cwd: projectRoot });
 // Sentinel: marks this worktree as provisioned (read by the fail-closed db guards).
 fs.mkdirSync(WORKTREE_DIR, { recursive: true });
 fs.writeFileSync(WORKTREE_META, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}
```

Delete `BASE_CONFIG` and `WORKTREE_CONFIG` constants and any append-based code. Keep `WORKTREE_DIR`/`WORKTREE_META`. (`materializeEnvLocal` is unchanged.)

- [ ] **Step 7: Typecheck + the unit test**

Run: `cd ~/code/stocktextalerts && npm run check:ts && npx vitest run tests/scripts/worktree-supabase.test.ts`
Expected: both pass.

- [ ] **Step 8: Commit**

```bash
cd ~/code/stocktextalerts
git add scripts/db/worktree-supabase.ts tests/scripts/worktree-supabase.test.ts
git commit -m "fix(db): write isolated worktree ports into config.toml in-place (CLI 2.105.0 dropped --config)"
```

---

## Task 0.2: Remove the `--config` injection and repoint the provisioned-check

**Files:**

- Rewrite: `scripts/db/supabase-cli-args.ts` → `scripts/db/worktree-state.ts` (rename to reflect the new role)
- Modify: `scripts/db/reset.ts`, `scripts/db/start.ts`

- [ ] **Step 1: Replace `supabase-cli-args.ts` with a provisioned-state helper**

Create `scripts/db/worktree-state.ts`:

```ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..", "..");
const WORKTREE_META = path.join(projectRoot, "supabase", ".worktree", "meta.json");

/** True when this worktree has an isolated Supabase stack provisioned (ports written into config.toml). */
export function worktreeSupabaseProvisioned(): boolean {
 return fs.existsSync(WORKTREE_META);
}
```

Delete `scripts/db/supabase-cli-args.ts`.

- [ ] **Step 2: Drop the flag spreads in `reset.ts` and `start.ts`**

In `scripts/db/reset.ts`: remove `import { supabaseCliArgs }`, remove `const supabaseArgs = supabaseCliArgs();`, and drop `...supabaseArgs` from the `supabase status` and `supabase db reset` invocations (the CLI reads the worktree's own `config.toml`).

In `scripts/db/start.ts`: remove `import { supabaseCliArgs }` and `const configArgs = supabaseCliArgs();`, and drop `...configArgs` from every `runSupabase([...])` call.

- [ ] **Step 3: Verify no dangling references**

Run: `cd ~/code/stocktextalerts && grep -rn "supabaseCliArgs\|supabase-cli-args\|--config" scripts/ tests/ | grep -v node_modules; npm run check:ts && npm run check:knip`
Expected: no matches for the removed symbols; typecheck + knip clean (knip confirms `worktreeSupabaseProvisioned` has a caller — if not yet, it's wired by worktree-provisioning Task 4/5; note that as expected-pending).

- [ ] **Step 4: Commit**

```bash
cd ~/code/stocktextalerts
git add scripts/db/worktree-state.ts scripts/db/reset.ts scripts/db/start.ts
git rm scripts/db/supabase-cli-args.ts
git commit -m "refactor(db): drop removed --config flag; gate worktree state on the meta.json sentinel"
```

---

## Task 0.3: End-to-end verification in a real throwaway worktree

**No file changes — this is the proof the migration works.** Requires Podman + local Supabase available.

- [ ] **Step 1: Create and provision a throwaway worktree**

```bash
cd ~/code/stocktextalerts
git worktree add .claude/worktrees/wt-supabase-smoke --detach   # --detach: no new branch (block-branch-create guard + "no self-initiated branches")
cd .claude/worktrees/wt-supabase-smoke
npm_config_cache="${TMPDIR:-/tmp}/stocktextalerts-npm-cache" npm ci   # $TMPDIR cache per the 2026-06-13 research
npm run db:worktree-setup        # runs ensureWorktreeSupabaseConfig → writes isolated config.toml + skip-worktree + meta.json
```

Expected: `db:worktree-setup` completes; `git status` shows `supabase/config.toml` **clean** (skip-worktree working); `cat supabase/.worktree/meta.json` shows a `stocktextalerts-wt-*` project_id and a non-default port block.

- [ ] **Step 2: Start + reset the isolated stack (no flag)**

```bash
npm run db:start && npm run db:reset && npm run db:doctor
```

Expected: stack starts on the **isolated** ports (e.g. `supabase status` shows API on 54331-ish, not 54321); `db:reset` + `db:doctor` pass; **no** unknown-flag error. Confirm the **main** stack is untouched: from `~/code/stocktextalerts`, `npm run db:doctor` still passes (seed intact).

- [ ] **Step 3: Tear down**

```bash
supabase stop --workdir ~/code/stocktextalerts/.claude/worktrees/wt-supabase-smoke
cd ~/code/stocktextalerts
git worktree remove .claude/worktrees/wt-supabase-smoke --force
```

Expected: isolated stack stopped, worktree removed. (Note: teardown uses `--workdir <dir>`, the supported flag, pointing at the worktree root.)

- [ ] **Step 4: Get Task 0 into the `toggle-state-desync` worktree, THEN re-provision (unblock the parallel agent)**

The fix only takes effect in a worktree once that worktree's **branch checkout** contains Task 0's code — `db:worktree-setup` runs `worktree-supabase.ts` from the worktree's own branch, so landing Task 0 on `main` alone does **not** fix the toggle worktree. Sequence:

1. **Land Task 0 first** (commits from Tasks 0.1–0.2 on `main`, pushed).
2. **Heads-up to the parallel agent before it merges:** Task 0 rewrites `scripts/db/worktree-supabase.ts`, `reset.ts`, `start.ts` and *deletes* `scripts/db/supabase-cli-args.ts`. If the toggle branch touched any of those, the merge conflicts — coordinate so it isn't mid-edit on those files. (Toggle-state-desync is frontend/state work, so a clean merge is likely, but confirm.)
3. In the toggle worktree, **merge `main`** (`git -C <toggle-worktree> merge origin/main` after the push) so its checkout has the new `worktree-supabase.ts` + the removed `supabase-cli-args.ts`.
4. **Then** re-provision: `npm run db:worktree-setup && npm run db:start && npm run db:reset` in that worktree. Its old `supabase/.worktree/config.toml` overlay (if present) is now ignored; the new run writes isolated ports into the worktree's `config.toml` + skip-worktree. Confirm its DB-backed tests run.

Running step 4 *before* steps 1–3 will appear to "re-provision" but stay broken — the worktree's branch code is still the old `--config` path. That's the gap to avoid.

---

## Alignment with worktree-provisioning (Tasks 4–7)

`docs/plans/2026-06-13-worktree-provisioning.md` stays the source of truth for Tasks 4–7, **with these deltas now that Task 0 changed the isolation mechanism:**

- **Provisioned-detection (Tasks 4 & 5).** The fail-closed `db:reset` guard and the `db:doctor` early check must key off **`worktreeSupabaseProvisioned()`** (from `scripts/db/worktree-state.ts`, the `meta.json` sentinel), **not** the deleted `worktreeSupabaseConfigPath()` / `.worktree/config.toml` path. Update the plan's `unsafeResetMessage` / `unprovisionedWorktreeMessage` wiring to import the new helper.
- **Task 6 `worktree:init`.** Already updated to `npm_config_cache="${TMPDIR:-/tmp}/…" npm ci && npm run db:bootstrap` (online; never `--offline`). `db:bootstrap` already chains `db:worktree-setup` (now CLI-2.105-compatible) → `db:start` → `db:reset` → `db:doctor`, so it works end-to-end once Task 0 lands.
- **Task 1** remains **superseded** (no `~/.npm` sandbox grant).
- **Tasks 2 & 3 (dotagents)** are **already shipped** (`8efd06b` + `7a847aa`).

So the net remaining sequence is: **Task 0 (this doc) → worktree-provisioning Tasks 4, 5, 6, 7.**

---

## Risks / open questions

1. **`skip-worktree` durability.** If `supabase/config.toml` changes upstream while a worktree is alive, that worktree won't see it (skip-worktree masks merges). Acceptable for short-lived worktrees; if a worktree is long-lived and config.toml changes, re-run `db:worktree-setup`. Document in Task 7's docs update.
2. **Does `db:gen-types` / `check-privileges` (called by `reset.ts`) need the isolated DB URL?** They read `DATABASE_URL` from the worktree's `.env.local` (materialized with isolated ports by `materializeEnvLocal`), not a CLI flag — so they're unaffected. Confirm during Task 0.3 Step 2 (the privilege check runs inside `db:reset`).
3. **`smol-toml` round-trip fidelity.** `stringify(parse(x))` may reorder keys / drop comments in `config.toml`. Since the file is now skip-worktree (never diffed/committed), cosmetic churn is invisible — but verify the serialized config still *starts* a stack (Task 0.3). If `smol-toml` mangles a needed structure, fall back to targeted string replacement of just the `port =` lines within known sections.
4. **Ship boundary.** Task 0 + Tasks 4–7 are dev-tooling (db scripts, tests, docs, package.json) — no runtime/Lambda change — so the eventual `/ship` deploy is low-risk, but it IS a deploy on push to main. Confirm before pushing.

## Self-Review

- **Spec coverage:** the `--config` removal (root cause), the duplicate-table secondary defect, and the 3 mechanism options all map to Tasks 0.1–0.3; acceptance criteria 1–7 are each exercised by Task 0.3's smoke or the unit test. ✅
- **Placeholder scan:** no TBD/"add error handling"; the one deliberate soft spot is Task 0.2 Step 3's knip note (the new helper's caller arrives in worktree-provisioning Task 4 — flagged as expected-pending, not missing). ✅
- **Type consistency:** `applyWorktreePorts(baseToml, {projectId, ports})` (Task 0.1) and `worktreeSupabaseProvisioned()` (Task 0.2) are defined and consumed with matching signatures; `WorktreePorts`/`WorktreeMeta` are the existing types in `worktree-supabase.ts`. ✅
