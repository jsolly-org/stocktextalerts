# Deploy-after-landing (stocktextalerts)

**Parent plan:** `~/code/dotagents/docs/plans/2026-06-24-deploy-after-landing.md` — the fleet-wide
design + rollout. The shared `gate_require_landed` primitive lives in dotagents `gate/gate-lib.sh`
(shipped in dotagents `d2d268b`). stocktextalerts is the **first child** of that rollout, proving the
gate-only-hook + guarded-deploy pattern end-to-end in prod.

## Invariant

Never deploy code that isn't up-to-date with `origin/main`. The hook GATES the landing; the deploy
FOLLOWS it and ships only `origin/main`'s landed HEAD.

## Changes

- `.git-hooks/pre-push` — **gate-only**: dropped the in-hook production deploy (`bash aws/deploy-web.sh`)
  and the now-vestigial `deploys` flag on `gate_begin`. The hook runs the full CI battery +
  `gate_require_clean_tree` and stops — it no longer deploys.
- `aws/deploy-web.sh` — calls **`gate_require_landed main`** at the top of the full-deploy path (after
  `--build`/`--preflight` exit, before Phase 1's build + Phase 2's one-way migration), so the deploy
  fails closed unless `HEAD == origin/main`. The `--build`/`--preflight` gate preflights are unaffected
  (they exit before the guard).
- `AGENTS.md` — deploy-model docs updated: the deploy is a post-push step (`npm run deploy:code`, run by
  `/ship` after the push lands, or by hand), not part of the pre-push hook.

## Deploy flow now

`git push` → pre-push gate (no deploy) → ref lands on `origin/main` → `npm run deploy:code` (post-push;
`/ship` runs it automatically) → `gate_require_landed` confirms `HEAD == origin/main` → Phases 1–4
deploy. A bare push lands without deploying; deploy via `/ship` or `npm run deploy:code`.
