# Deploy: build the Lambda bundle before the one-way migration

## Spec

**Problem.** On 2026-06-21 a production deploy left **prod DB ahead of prod code**. The deploy ran
in the order `supabase db push` (Phase 1, irreversible) → `sam build` (Phase 2). A native `.node`
binary in `@resvg/resvg-js` broke the esbuild bundling step, so `sam build` failed — but the
migration had *already* applied. Prod ran the old Lambda code against the new schema until the build
was fixed (commit `228cb5df`: load resvg lazily + mark it external).

Two gaps made this possible:

1. **The pre-push gate never built the Lambda bundle.** `npm run build` is `astro build` (web only).
   The handler bundle was first built during the deploy itself, so a bundler break could only surface
   *after* the gate had passed — and, with the old ordering, after prod was migrated.
2. **The deploy ran the irreversible step before the reversible one.** `supabase db push` (one-way)
   preceded the offline, side-effect-free `sam build`. A build that fails after the migration is the
   worst case; a build that fails before it touches nothing.

**Goal.** Make a Lambda-bundle build failure impossible to reach prod-affecting state, via two
complementary, independent fixes.

**Acceptance.**

- The pre-push gate fails fast (seconds, before the test battery) on a handler-bundle build break.
- `aws/deploy-web.sh` builds the bundle *before* it migrates prod; a build failure leaves prod untouched.
- Neither the gate build nor a *failed* deploy build leaves `src/lib/logging/release-id.ts` modified
  (which would trip `gate_require_clean_tree` on the next push).
- All grounded per `rules/dependency-grounding.md` (mise-pinned `sam`, presence guards, pinned esbuild).

## What shipped

### 1. `aws/deploy-web.sh` — build before migrate, hardened, with a reusable `--build` mode

- New phase order: **Phase 1 `sam build`** → Phase 2 `supabase db push` → Phase 3 Lambda code upload
  → Phase 4 Vercel. The build is offline, so moving it ahead of the migration is free and removes the
  whole failure class. Invariant, stated in the header: *never run an irreversible step before every
  reversible validation that can fail has passed.* Vercel stays last.
- Extracted `build_lambdas()` — `gen-release-id → sam build → restore-stub`, but **the stub is
  restored even when the build fails** (`(cd aws && sam build …) || rc=$?; restore; return rc`). The
  old inline sequence let `set -e` abort before `restore-release-stub`, leaving the tracked
  `release-id.ts` dirty on exactly the failure we now guard against (stub-dirtying history:
  `ee70c6b`/`b6c74e5`).
- New `--build` mode runs `build_lambdas()` alone, **credential-free** (dispatched before Phase 0's
  cred load), exposed as `npm run build:lambdas` for a local check that needs no AWS/DB/Vercel creds.
- The `node_modules/.bin` PATH export + mise activation moved ahead of the mode dispatch so `--build`,
  `--preflight`, and the full deploy all resolve the pinned `sam`/esbuild/`supabase`/`vercel`.

### 2. `.git-hooks/pre-push` — the gate builds the bundle as a fail-fast preflight

`run_step "lambda bundle build …" bash aws/deploy-web.sh --build`, placed in the cheap-preflights
block (before the ~15-minute battery and before the deploy). Catches a resvg-class break in ~4s.

### 3. `package.json` — `build:lambdas` script; `docs/prepush-gate.md` updated

## Verification

- `bash -n` clean on both scripts; `gate_check_dep_grounding` clean over `.git-hooks/pre-push scripts/*.sh aws/*.sh`.
- `npm run build:lambdas` → "Build Succeeded" in ~3.7s, working tree unchanged afterward.
- Injected an unresolvable import into a handler → `--build` exits **1** *and* `release-id.ts` is
  restored clean (the hardened restore-on-failure).
- `--preflight` validates real AWS + prod-DB + Vercel creds (the refactored bare-command path).

## Fleet-wide consideration

The **reorder (fix 2) is stocktextalerts-specific**: it is the only deploy repo that runs an
irreversible step (`supabase db push`) before building its Lambda artifact. The other fleet
deploy repos are already structurally safe:

| Repo | Deploy shape | Migrate-before-build hazard? |
| --- | --- | --- |
| **stocktextalerts** | Supabase migrate + Lambda code + Vercel | **Yes — fixed here** |
| family-memory | code-only Lambda (`sam build` is the first mutating step; preceded only by a read-only smoke test) | No |
| shared-infra | code-only Lambda (`sam build` first; no DB migration) | No |
| misc-notifications | gate-only; deploy is a manual `npm run deploy` | No |
| awesome-django-blog | Heroku git-push (Heroku builds remotely) | N/A |

The **gate build (fix 1)** could be a minor fail-fast nicety for family-memory/shared-infra (they
build inside their deploy block, after the battery, rather than as an early preflight), but it is not
a correctness fix for them — their build is already the first mutating action with nothing
irreversible ahead of it. Not replicating now; the build-before-anything-irreversible invariant is
the portable lesson, and both already satisfy it.
