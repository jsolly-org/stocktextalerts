# shared-infra operator emails

StockTextAlerts routes CloudWatch alarms through the shared [shared-infra](https://github.com/jsolly/shared-infra) SNS topic. The enricher formats plaintext emails with `error:`, `log:` or structured `log-search:` handles, `alarm:`, and `state:` — not raw SNS JSON. See `~/code/shared-infra/docs/architecture.md` for the full contract and agent log lookup playbook.

## Alarm categories

| Alarm | Enrichment |
| --- | --- |
| `stocktextalerts-error-logs` | Logs Insights across `/aws/lambda/stocktextalerts-*` (metric math; vendor-retry metrics subtracted) |
| `stocktextalerts-*-vendor-retry` | Same namespace discovery → schedule / asset-events / compute-daily-stats log groups |
| `stocktextalerts-*-lambda-errors` | Lambda runtime **`Errors`** metric (`AWS/Lambda`, `FunctionName` dimension) — invocation threw, timed out, or OOM; not the same as vendor-retry log metrics |
| `stocktextalerts-*-invocation-failures` | Passthrough only (`AWS/Scheduler`) — short CloudWatch reason |
| `stocktextalerts-backup-user-settings-stale` | Passthrough — custom metric (`stocktextalerts/Backup` namespace, `BackupSuccess` heartbeat); fires when no successful user-settings backup in 6h. The alarm body ("no backup in 6h") is the whole signal — no log enrichment. |
| `stocktextalerts-live-provider-tests` | Passthrough — reason may include a GitHub Actions run URL |

All alarms use explicit `AlarmName` values in `aws/template.yaml` so email subjects stay stable.

## Email lookup handles (agent-oriented)

When log groups are discovered, ALARM emails may also include machine-readable lines such as:

- `region:`, `account:`, `alarm-name:`
- `log-group:` (repeat of the primary group)
- `request-id:` and `request-id-source:` (`lambda-runtime` or `json`)
- `time-start:`, `time-end:`, `time-start-epoch:`, `time-end-epoch:`
- `insights-query:` (standard error query including `@logStream`)
- `insights-query-request:` (optional, filters by request id)
- `action:` (optional, from `context.action` in the primary error log)
- `related-log-1:`, `related-log-2:`, `related-more:`

Use these lines to run CloudWatch Logs Insights without opening the console. Full payloads and stacks stay in CloudWatch logs, not in the email.

Example follow-up query after pasting an email:

```bash
aws logs start-query \
  --region us-east-1 \
  --log-group-name "/aws/lambda/stocktextalerts-asset-events" \
  --start-time <time-start-epoch> \
  --end-time <time-end-epoch> \
  --query-string 'fields @timestamp, @message, @logStream | filter @message like /<request-id>/ | sort @timestamp asc | limit 100'
```

## Massive vendor timeout triage (schedule Lambda)

When `stocktextalerts-schedule-vendor-retry` or `stocktextalerts-schedule-lambda-errors` fires during a Massive REST outage:

1. Check [Massive status](https://massive-status.com/) for REST latency/timeout incidents.
2. Distinguish the alarms:
   - **`stocktextalerts-schedule-vendor-retry`** — sustained `context.category = "vendor_retry_exhausted"` in schedule logs (Massive/Finnhub critical routes exhausted retries). Absorbs brief blips; pages on ≥3 minute-buckets in 10 minutes.
   - **`stocktextalerts-schedule-lambda-errors`** — Lambda runtime **`Errors`** metric for `stocktextalerts-schedule` (threw, **timed out** at 300s, or OOM). Vendor retry log lines may appear in the same window without being the alarm source.
   - **`stocktextalerts-error-logs`** — app errors **excluding** vendor retry exhaustion (metric math in `aws/template.yaml`).
3. Find vendor retry lines for the window:

```text
fields @timestamp, @message, @logStream
| filter level = "error"
| filter context.category = "vendor_retry_exhausted"
| sort @timestamp desc
| limit 50
```

1. Check whether the invocation also failed (timeout vs clean completion):

```text
fields @timestamp, @message, @logStream
| filter @message like /REPORT RequestId: <request-id>/
   or @message like /Task timed out/
   or @message like /Schedule failed/
| sort @timestamp asc
| limit 20
```

1. Look for `action: "schedule_complete"` vs elevated `skipped` counts in fallback delivery when snapshot quotes returned all-null maps.

See also `docs/external-apis.md` for critical vs optional Massive routes and retry policy defaults (25s × 3 attempts).

## Logging fields shared-infra reads

Page-worthy failures must call `logger.error(message, context, err)` so the serialized line includes top-level `error.name` and `error.message`. Use `createErrorForLogging(unknown)` from `src/lib/logging/errors.ts` for caught values; pass Postgrest-like objects through unchanged (do not wrap in `new Error(...)`). Do not put the failure text in `context.error` — shared-infra ignores it.

Lambda handlers import `runWithRequestContext` from `src/lib/logging/request-context.ts` (Node-only) so JSON logs include `requestId` matching the runtime tab-prefix.

`stocktextalerts-email-dispatch` is invoked by Vercel through a Lambda Function URL. It
uses HMAC request authentication and SES execution-role permissions to send app-triggered
registration/approval emails without AWS credentials in Vercel. Its errors are covered by
`stocktextalerts-email-dispatch-lambda-errors` and the aggregate `stocktextalerts-error-logs`.

Representative shapes (see `tests/lib/logging/contract.test.ts`):

- **Vendor retry exhaustion** — `message` + `context.category: "vendor_retry_exhausted"` + `error` object
- **Database / schema** — `message` + `error.message` from PostgREST or `Error` as the third argument
- **Deterministic validation** — `new Error("…")` as the third argument when nothing was thrown
- **Finnhub enrichment** — `action: "fetch_finnhub_enrichment"` or `load_finnhub_enrichment` on read failures

## Bounded payload logging

Use `preparePayloadForLog` and `payloadLogFields` from `src/lib/logging/log-payload.ts` on rare error paths:

- Log full redacted payloads when serialized size ≤ 4 KiB (`payloadMode: "full"`).
- Log previews with byte counts when larger (`payloadMode: "preview"`, `truncated: true`).
- Standard preview keys: `bodyPreview`, `payloadSummary`, `proposedRowsPreview`.

Never log: SMS/email bodies, staged HTML, passwords, auth headers, Twilio signatures, provider URLs with API keys, or full Finnhub insider names in bulk previews.

## Deploy note

Adding or changing `AlarmName` on an existing alarm resource may replace the CloudWatch alarm on stack update. Expect one transition email if state changes during deploy.
