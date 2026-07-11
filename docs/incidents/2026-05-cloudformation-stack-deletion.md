# 2026-05-29 — Production `stocktextalerts-crons` stack deleted in a bulk cleanup

## Summary

The production CloudFormation stack `stocktextalerts-crons` was deleted at 2026-05-29 19:12 EDT (23:12 UTC), taking down all scheduled notifications. The per-minute `ScheduleFunction` is the core dispatcher, so scheduled email/Telegram notifications were fully down from 19:12 EDT until the stack was recreated at ~21:56 EDT (2026-05-30 01:56 UTC) — roughly 2h45m of downtime. No data was lost.

## Root cause

The deletion was **manual operator error, not CI**. CloudTrail attributes the `DeleteStack` call to an admin SSO role (not the GitHub Actions deploy role) from a redacted operator IP via `aws-cli` — not the `GitHubActionsDeploymentRole` that CI deploys with.

It was collateral in a bulk multi-stack teardown. The same burst of `DeleteStack` calls also targeted unrelated sandbox/experiment stacks in the account. The intent appears to have been clearing those experiments; the production crons stack was swept up alongside them.

## Blast radius

Destroyed with the stack:

- 3 Lambdas: `stocktextalerts-schedule`, `stocktextalerts-asset-events`, `stocktextalerts-compute-daily-stats`
- The shared `StockTextAlertsSchedulerRole` and the 3 functions' execution roles
- 3 EventBridge schedules (per-minute, daily-midnight, weekday-evening)
- 10 CloudWatch alarms, 3 log groups, 6 metric filters

Unaffected (no action needed):

- **Supabase** — all user data. It is a separate managed service, not in this AWS account. No user data ever lived in the stack.
- **Vercel website** — separate platform; stayed up the whole time.
- `ProdBackupsBucket` (`stocktextalerts-prod-backups-<account-id>`) — survived via `DeletionPolicy: Retain`, with its `20260510` dump intact.
- SES identity `stocktextalerts.com`, the alert-hub SNS topic, and the SSM params `/stocktextalerts/email-from` and `/alert-hub/alert-topic-arn`.

## Two failed re-deploy attempts

Around 21:37–21:38 EDT (01:37–01:38 UTC) two `sam deploy` attempts ran. Both only reached `REVIEW_IN_PROGRESS` and were deleted within seconds, never entering `CREATE_IN_PROGRESS` — the signature of a from-scratch `sam deploy` failing/aborting at the change-set stage and auto-cleaning the empty stack shell. The exact reason is unconfirmed (the change sets were deleted with the stacks, and CloudTrail does not log change-set status reasons). It is bypassed entirely by the import-first recovery below, which makes the deploy an UPDATE of an existing stack rather than a CREATE.

## Why a naive `sam deploy` would not have worked

The retained `ProdBackupsBucket` physically survived but is still declared in `aws/template.yaml` with a fixed name. A from-scratch `sam deploy` would have hit `BucketAlreadyExists` on that resource and rolled back. The bucket must be re-adopted via CloudFormation import before the rest of the stack is created.

## Resolution (import-first recovery)

1. Created `aws/import-prod-backups.yaml` — a one-off template containing only `ProdBackupsBucket` (verbatim copy of the block in `template.yaml`).
2. Ran a CloudFormation `IMPORT` change set using `aws/resources-to-import.json` to re-adopt the surviving bucket into a fresh `stocktextalerts-crons` stack (→ `IMPORT_COMPLETE`).
3. Ran `cd aws && ./deploy.sh`, which became a stack UPDATE that layered on the Lambdas, scheduler role, schedules, alarms, log groups, and metric filters (→ `UPDATE_COMPLETE`, 30 resources).
4. Verified: all 3 Lambdas `Active`, all 3 schedules `ENABLED`, 10 alarms present, and the per-minute dispatcher running cleanly against prod Supabase with 0 errors.

CI needed no changes: the `deploy-lambdas` job in `.github/workflows/deploy.yml` updates Lambda code by fixed function name, which works again now that the functions exist.

## Mitigations

- **Enabled stack termination protection** on `stocktextalerts-crons` so a future bulk `DeleteStack` sweep skips it:
  `aws cloudformation update-termination-protection --enable-termination-protection --stack-name stocktextalerts-crons`.
- **Committed `aws/import-prod-backups.yaml`** alongside `aws/resources-to-import.json` so the bucket-import bootstrap is a repeatable, documented DR step rather than ad-hoc.

## Standing rules

- **Keep termination protection on the production stack.** It is the cheapest guard against an accidental bulk-delete.
- **Recreating the stack from scratch is a two-step operation** because of the retained bucket: import `ProdBackupsBucket` first (`aws/import-prod-backups.yaml` + `aws/resources-to-import.json`), then `./deploy.sh`. A plain `sam deploy` against a missing stack will collide on the bucket name.
- **Bulk stack cleanups must allow-list, not deny-list.** When tearing down sandbox/experiment stacks, target explicit stack names; never loop over "all stacks" in an account that also hosts production.
