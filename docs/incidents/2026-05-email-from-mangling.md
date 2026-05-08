# 2026-04-29 to 2026-05-05 — Lambda emails silently failing after SAM param refactor

## Summary

Every email send from the schedule and asset-events Lambdas failed for ~6 days with `BadRequestException: Missing final '@domain'` from SES. The failures only surfaced on 2026-05-05 when the `stocktextalerts-error-logs` alarm finally tripped.

## Root cause

`aws/sam-params.sh` (introduced 2026-04-23 in commit `f50a1c29`) defined the SES From-address as a single bash array element:

```bash
"EmailFrom=StockTextAlerts <notifications@stocktextalerts.com>"
```

`sam deploy --parameter-overrides "${SAM_PARAMS[@]}"` uses the shorthand parameter format, which re-splits values on whitespace regardless of how the shell quotes individual argv elements. The value reaching CloudFormation was truncated to `StockTextAlerts` — a bare brand name with no `@`. SES rejected every send.

The truncation didn't reach prod until commit `de488646` (2026-04-29) renamed the Lambda `FunctionName`s, which forced full Lambda recreation; the new functions came up with the broken env var. Errors started 13:00 UTC the next day.

## Why it took 6 days to alarm

The `ErrorLogAlarm` was configured with `Period: 300, EvaluationPeriods: 3, DatapointsToAlarm: 3` — three consecutive 5-minute windows each containing ≥ 1 error log line. Email sends only happen during scheduled cron windows (market open), so isolated daily clusters didn't sustain across three windows until errors finally clustered into 13:54 / 13:59 / 14:04 on 2026-05-05.

## Why one user dominated the logs

The SES error path logged with no `userId` or `to`. Only the flat-price-alert flow logged a paired downstream error with `userId`, so one user (whose flat-price alert fired on PLTR during the window) was the only `userId` visible. The failure was global, not user-specific.

## Resolution

1. Switched the `EmailFrom` CloudFormation parameter to `AWS::SSM::Parameter::Value<String>` with `Default: /stocktextalerts/email-from`. The address (display name + email, with whitespace) lives in SSM Parameter Store; CloudFormation resolves it at deploy time without going through `--parameter-overrides`. This matches the existing pattern for `AlertTopicArn`.
2. Tightened `ErrorLogAlarm` to `Period: 60, EvaluationPeriods: 1, DatapointsToAlarm: 1` so any single error log line fires within ~1 minute. Per-attempt retry failures stay at `warn` (not `error`), so transient retry churn doesn't page; only final-retry exhaustion alarms. **(Updated 2026-05-08: vendor retry exhaustion is now tagged with `category: "vendor_retry_exhausted"` and excluded from `ErrorLogAlarm` via metric math; per-Lambda alarms route those instead — `ScheduleVendorRetryAlarm` (sustained, 3-of-10), `AssetEventsVendorRetryAlarm` (1-of-1), `ComputeDailyStatsVendorRetryAlarm` (1-of-1).)**
3. Threaded `userId` through `EmailRequest` so the SES error path includes it — no more triangulating which user failed via downstream paired logs.
4. Deleted unused Vercel env vars (`EMAIL_FROM`, `AWS_*`, `VERCEL_PROJECT_PRODUCTION_URL`) — the SES sender is Lambda-only; transactional auth emails on Vercel go through Supabase Auth's SMTP, not our `createEmailSender`.

## Standing rules

- **Any CloudFormation parameter whose value contains whitespace must be SSM-backed.** The shorthand `--parameter-overrides Key=Value` form will silently truncate at the first whitespace. SSM-backed params (`Type: AWS::SSM::Parameter::Value<String>` with a `Default: /path` pointer) bypass shell→CLI argv parsing entirely.
- See [docs/deploy-gotchas.md](../deploy-gotchas.md).
