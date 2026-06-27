# 2026-03-29 to 2026-03-31 — Notifications down during Resend → SES migration

## Summary

Notifications were down Mar 29–31 2026 because a feature-branch SAM deploy removed the `RESEND_API_KEY` env var from the production Lambda before the Resend → SES migration (PR #414) merged to `main`. The Lambda picked up the new template (without `RESEND_API_KEY`) but the application code was still reading it.

## Root cause

A SAM deploy from a feature branch overwrites the live Lambda's full configuration (env vars, runtime, layers, etc.). Removing an env var in the template removes it from the live function immediately, even if the application code hasn't switched away from it yet.

## Resolution

Merge PR #414, redeploy from `main`. Production was healthy once the new SES sender path was live alongside the env vars it required.

## Standing rule

See [docs/deploy-gotchas.md](../deploy-gotchas.md): any PR that adds, removes, or renames a Lambda env var must merge to `main` before deploy.
