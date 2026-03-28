## AWS Infrastructure

### AWS CLI Profile

Use `--profile prod-admin` for all production AWS commands.

### Lambda Functions

| Log Group | Purpose |
|-----------|---------|
| `/aws/lambda/stocktextalerts-crons-ScheduleFunction-ZAF7TV5P6wti` | Scheduled notification cron |
| `/aws/lambda/stocktextalerts-crons-AssetEventsFunction-esg6gQfeBLkm` | Asset events processing |
| `/aws/lambda/stocktextalerts-crons-ComputeDailyStatsFunction-u4550C06Ww9P` | Daily stats computation |
| `/aws/lambda/textnotifications-app-prod-message-sender` | SMS/message delivery |
| `/aws/lambda/textnotifications-app-prod-signup-processor` | Signup processing |

### Local Lambda Testing

Requires Docker running. Builds the Lambda bundles, generates `env.json` from `.env.local` with per-function env var scoping, and invokes all three handlers locally.

```bash
cd aws

# Test all functions
npm run local:test-all

# Test a single function
npm run build && npm run local:gen-env
npm run local:schedule
npm run local:asset-events
npm run local:daily-stats
```

This catches packaging, env var, and init errors that Vitest-based tests miss. The GitHub Actions live tests (`live-provider-tests.yml`) test provider APIs directly without SAM — they are a separate concern.

### Checking CloudWatch Logs

```bash
# Recent logs (last 2 hours) for a Lambda
aws --profile prod-admin logs tail /aws/lambda/stocktextalerts-crons-ScheduleFunction-ZAF7TV5P6wti --since 2h --format short

# Follow logs in real time
aws --profile prod-admin logs tail /aws/lambda/stocktextalerts-crons-ScheduleFunction-ZAF7TV5P6wti --follow --format short

# Search for errors in the last 24 hours
aws --profile prod-admin logs filter-log-events \
  --log-group-name /aws/lambda/stocktextalerts-crons-ScheduleFunction-ZAF7TV5P6wti \
  --start-time $(date -v-24H +%s000) \
  --filter-pattern "ERROR"
```
