# alert-hub operator emails

StockTextAlerts routes CloudWatch alarms through the shared [alert-hub](https://github.com/jsolly/alert-hub) SNS topic. The enricher formats plaintext emails with `error:`, `log:` or `log-search:`, `alarm:`, and `state:` — not raw SNS JSON. See `~/code/alert-hub/docs/architecture.md` for the full contract.

## Alarm categories

| Alarm | Enrichment |
| --- | --- |
| `stocktextalerts-error-logs` | Logs Insights across `/aws/lambda/stocktextalerts-*` (metric math; vendor-retry metrics subtracted) |
| `stocktextalerts-*-vendor-retry` | Same namespace discovery → schedule / asset-events / compute-daily-stats log groups |
| `stocktextalerts-*-lambda-errors` | `FunctionName` dimension → that Lambda’s log group; `log:` when a recent structured error exists, else `log-search:` |
| `stocktextalerts-*-invocation-failures` | Passthrough only (`AWS/Scheduler`) — short CloudWatch reason |
| `stocktextalerts-live-provider-tests` | Passthrough — reason may include a GitHub Actions run URL |

All alarms use explicit `AlarmName` values in `aws/template.yaml` so email subjects stay stable.

## Logging fields alert-hub reads

Page-worthy failures should call `logger.error(message, context, err)` so the serialized line includes top-level `error.name` and `error.message`. alert-hub also falls back to `context.error` when no throwable exists.

Representative shapes (see `tests/lib/logging/contract.test.ts`):

- **Vendor retry exhaustion** — `message` + `context.category: "vendor_retry_exhausted"` + `error` object
- **Database / schema** — `message` + `error.message` from PostgREST or `Error`
- **No throwable** — readable `context.error` string only when nothing can be passed as the third argument

## Deploy note

Adding or changing `AlarmName` on an existing alarm resource may replace the CloudWatch alarm on stack update. Expect one transition email if state changes during deploy.
