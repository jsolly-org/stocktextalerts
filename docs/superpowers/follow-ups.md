# Follow-ups

Items deferred from completed work. Each entry: short context + when it surfaced. Pick up when the relevant adjacent work is fresh in mind.

## Create a skill for alert-hub integration

**Surfaced:** during backup-schedule brainstorm (2026-05-08), while reviewing whether the new `BackupFunction` Lambda properly leverages alert-hub.

**Why:** wiring a new Lambda to alert-hub correctly requires getting ~7 non-obvious things right, spread across files in two repos (`~/code/alert-hub/docs/` + `~/code/stocktextalerts/aws/template.yaml` + `~/.agents/rules/errors-and-logging.md` + the canonical logger in `src/lib/logging`). Missing any single point silently degrades enrichment without an obvious failure mode (e.g., forgetting to declare an explicit `AWS::Logs::LogGroup` means alarm emails arrive unenriched). Every future Lambda repeats this re-derivation work.

**Shape (rough):**

- Lives at `~/.agents/skills/alert-hub-integration/SKILL.md` (per AGENTS.md skill location).
- Description targets phrases like "add a new Lambda", "wire alarms", "alert-hub integration".
- Content:
  - Short prose summary of the contract (cross-reference `~/code/alert-hub/docs/adding-a-project.md`, don't duplicate).
  - Canonical SAM snippet template — `<Name>LogGroup` + `<Name>ErrorLogFilter` (feeds shared `<namespace>/ErrorLogCount`) + `<Name>FunctionErrorAlarm` (`AWS/Lambda Errors`, with both `AlarmActions` and `OKActions`) + `<Name>FunctionScheduleFailureAlarm` (`AWS/Scheduler TargetErrorCount`).
  - 7-point integration checklist (SSM lookup, both alarm-action lists, explicit log group, namespace = function family, logger field shape with `error.name`/`error.message` at top level, infrastructure-namespace passthrough behavior, recursion-guard naming).
  - Reminder that the project-level rule file `~/.agents/rules/errors-and-logging.md` is *separate concerns* (errors-and-logging philosophy) — the skill cross-references it but doesn't replace it.

**Why defer until after backup-schedule ships:** the backup work adds a second concrete example (alongside the three existing Lambdas in this repo's template) of "Lambda wired to alert-hub." Two examples make it easier to factor out reusable boilerplate vs. project-specific incidentals when writing the skill.

---

## Decide where git worktrees should live

**Surfaced:** 2026-05-08, while patching `biome.jsonc` to stop scanning into worktrees. Reinforced 2026-05-09 when the same `biome.jsonc` patch was found to break biome auto-discovery from *inside* a worktree (the dual-direction trap of nested-config tooling).

**Why:** Claude Code's native `EnterWorktree` tool defaults to `.claude/worktrees/<branch>/` — under the harness's config dir, inside the repo. This caused biome 2.x's "nested root configuration" startup error because the worktree contains its own checked-in `biome.jsonc` (same file, different branch). We patched the root `biome.jsonc` to ignore `.claude`, `.worktrees`, and `worktrees` — but the underlying convention is still suboptimal:

- Mixes harness state (settings, hooks) with working code.
- Other tools (eslint, jest, tsserver config discovery) have the same descend-into-worktree behavior and could trip later.
- `.claude/` isn't gitignored, so accidental commits of harness state are possible.
- The biome exclude pattern itself had to be tweaked twice: first overly-broad (`!**/.claude`) silently turned `biome ci .` into a no-op when run from inside a worktree (pre-commit hook gate vanished); the root-anchored form (`!.claude`) fixes that direction but the underlying brittleness remains.

**Options to weigh:**
1. Configure the harness to use `.worktrees/` at the repo root (the location the `superpowers:using-git-worktrees` skill itself prefers).
2. Move worktrees outside the repo entirely (sibling dir like `../stocktextalerts-<branch>/`). Linus's recommended pattern; eliminates in-tree collisions for any tool. Requires figuring out how to configure `EnterWorktree` for a non-default base path.
3. Keep current location, accept that any new tool we adopt may need an exclusion patch like the biome one.

---

## Verify Massive's half-day after-hours behavior

**Surfaced:** during extended-hours-notifications design (2026-05-08) and again at implementation (2026-05-09).

**Why:** on US half-days (regular trading ends at 1:00 PM ET, no after-hours session), Massive's `/v1/marketstatus/now` *should* return `market: "closed"` from 1:00 PM ET onward. We didn't live-verify this. If Massive instead returns `afterHours: true` between 1:00 PM and 4:00 PM ET on those days, the new runtime session detection in `getCurrentMarketSession` would classify the session as `"after"` and fire scheduled notifications with a `day.close` baseline — likely the wrong number, since the regular close just happened minutes earlier.

**Tracked as:** `tests/lib/schedule/run.test.ts` has an `it.skip("On a half-day after 1:00 PM ET, if Massive returns 'after', behavior is TBD pending live verification", ...)` with a `// TODO(half-day-verification): resolve before final commit, by 2026-05-15` comment. The skipped test serves as the placeholder; resolving it requires either (a) live observation on a real half-day or (b) Massive support clarification.

**Half-days in 2026 to watch:** day before Thanksgiving (Wed Nov 25), Christmas Eve (Thu Dec 24), day after Thanksgiving (Fri Nov 27 — 1:00 PM close).

**If Massive does return `"after"` during the half-day dead zone:** the simplest mitigation is a pre-check in `getCurrentMarketSession` against `getUsMarketClosureInfoForInstant` — if the calendar says it's a half-day and current ET time is past the early close, override the session to `"closed"`. This stays in the runtime session-detection layer and avoids per-asset adjustments downstream.
