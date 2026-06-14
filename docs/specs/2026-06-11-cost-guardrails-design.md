# Cost Guardrails: Runaway-Cost Circuit Breakers

**Date:** 2026-06-11
**Status:** Approved (interview-driven design, all branches resolved)
**Scope:** stocktextalerts app + shared-infra account-level breaker (cross-repo; shared-infra changes are specified here and implemented in `~/code/shared-infra`)

## Goal

Bound the worst-case dollar cost of any runaway — a stuck Lambda, an alert loop, a retry storm, a logic bug that sends fresh messages every minute — so that an incident at 3am stops itself in minutes and caps total damage at a known dollar amount, without a human in the loop. Notifications about the incident continue; the incident itself does not.

**Non-goals:**

- Reducing normal operating cost. (Noted in passing: SMS bodies average ~7 segments/message, so message length is a 7x cost lever — explicitly out of scope here.)
- Protecting against malicious external actors (fraud, credential theft). This design targets self-inflicted runaways.
- High availability of sends during an incident. Fail-closed is the accepted posture: when a breaker trips, all of the project's sends stop until a human re-arms.

## Problem

The system has good *retry* hygiene (claim-based idempotency, capped retries, SQS DLQ at maxReceiveCount=5, a vendor circuit breaker) but no *volume* controls: no per-user or global send caps, no kill switch, no cost-denominated alarm. AWS Budgets exist but are email-only — by the time billing data moves, 7–33 hours have passed.

This is not hypothetical. **On 2026-06-08, one user was sent 199 `flat_price_alert` SMS in a single day** (~1,400 segments ≈ $11–12 — a third of a normal month's Twilio spend in one day). Flat price alerts re-trigger on every 5% move from the last alert price and were the only send type with no daily bound. Until 2026-06-11, Twilio auto-recharge was uncapped, so the theoretical worst case (~60k SMS/hour from the minute-cron at ~5.8¢/message ≈ **$3,500/hour**) was bounded only by Twilio noticing.

### Production anchors (queried 2026-06-11)

| Fact | Value |
| --- | --- |
| Users | 11 total, 7 SMS-capable, 6 email-enabled |
| Max tracked assets/user | 10 |
| Normal SMS volume | 16/day avg, p95 ~29/day, no legit day above ~50 (90-day window) |
| Busiest legit 5-min window | ~7–14 (market-close schedule slot) |
| Bounded legit ceiling/user/day | ~25 SMS (8 scheduled + 10 anomaly + 1 digest + ~2 asset-events + targets) |
| Twilio spend | ~$26–44/month; ~7 segments/message at $0.0083/segment (toll-free) ≈ 5.8¢/message |
| Twilio balance | $100 fixed, auto-recharge disabled (done 2026-06-11) |
| Incident day | 2026-06-08: 199 flat-alert SMS to one user, all delivered |

Cost surfaces: **Twilio SMS** (dominant), **xAI/Grok** (price-alert enrichment + digest rumors), **AWS compute** (minute-cron × 1,440/day). Massive ($29/mo flat, unlimited requests) and Finnhub (free tier) are flat-rate and cannot run up a bill — worst case is 429s, already handled by capped retries. SES is negligible (~$0.10/1k) and rate-limited in code at 14/sec.

## Design: six layers, outermost first

Defense in depth with a deliberate blast-radius ladder: weird ticker → that symbol goes quiet; buggy logic → that user caps; project runaway → project dies in ~5 minutes; total automation failure → prepaid floor bounds the damage.

### Layer 0 — Provider-side prepaid hard caps (no code, can't be bypassed by our own bugs)

- **Twilio:** auto-recharge OFF, fixed ~$100 balance (~2 months runway), manual top-up on low-balance email. Worst-case exposure ≈ $100 (balance can dip slightly negative on in-flight sends). **Done.** Plus a notification-only Twilio Usage Trigger at ~100 messages/day (email alert; no webhook machinery — the documented subaccount-suspend pattern was considered and rejected as overkill at 11 users).
- **xAI:** prepaid; auto top-up $5 at $5 floor, capped $10/month. Worst-case Grok damage = current balance + $10/month. **Already configured.**
- Massive/Finnhub: flat-rate, nothing to do. SES: nothing to do.

### Layer 1 — App-level send caps (Postgres atomic claims, stocktextalerts)

- **Flat price alerts: max 5 per user/symbol/trading-day**, enforced in the same DB claim pattern as anomaly alerts (counter on `price_move_alert_state`, claimed atomically). This was the only unbounded send type and the root cause of the 2026-06-08 incident, which this cap would have cut from 199 to 5. Moves past the cap are dropped (alert #6 about the same ticker adds nothing).
- **All-types ceiling: 40 SMS per user per day**, checked at send time (legit bounded max is ~25). Suppressed sends are recorded (logged at `warn` + visible in `notification_log` semantics) — never silently dropped without trace.
- Grok needs no new cap: every enrichment call hangs off a claimed alert slot, so Grok calls are transitively bounded by Layer 1 (≤10 anomaly + ≤50 flat per user/day) with retries already capped at 3. The existing digest window (`grok_sends_in_window`, 10/24h/user) stays. A notification-only Grok volume alarm provides visibility so a Grok runaway can't silently drain the balance.

### Layer 2 — Standing reserved concurrency (real-time throttle, stocktextalerts `aws/template.yaml`)

| Function | Reserved concurrency | Why |
| --- | --- | --- |
| schedule | 2 | normal is 1; allows brief overlap; caps the 300s-timeout × 1-min-rate stack-up at 2 instead of 5 |
| asset-events | 1 | daily, no legit concurrency |
| compute-daily-stats | 1 | daily, no legit concurrency |
| vendor-backfill | 2 | SQS batches; bounded backfill |
| email-dispatch | 2 | operator-triggered, low volume; bounds a hammered Lambda URL at the front door |

Total 8 of the account's 1,000 — no fleet impact. Rationale over "just gate on invocations": cron invocation *rate* is fixed by the scheduler and never moves during a runaway; the dimension that moves is concurrency (overlap), and concurrency caps are enforcement at zero latency rather than detection after an alarm cycle. They also reuse the exact mechanism the breaker actuates (`PutFunctionConcurrency`), so the standing caps are free.

### Layer 3 — Volume tripwires (CloudWatch metric filters, stocktextalerts)

- **Metric source:** the Twilio send wrapper's success path — count actual Twilio API calls, *not* `notification_log` rows, so the metric cannot go blind if a bug bypasses the claim/logging path. Email gets the same metric for visibility, no breaker wiring.
- **Mandatory sparse-data config** (without this the tripwire silently never fires): `defaultValue: 0` on the metric transformation **and** `treatMissingData: notBreaching` on the alarms. Send-count metrics publish nothing (absent, not zero) between events; CloudWatch defaults park such alarms in `INSUFFICIENT_DATA` forever.
- **Three alarms on the one SMS metric, all → the breaker topic:**

| Tier | Threshold | Window | Catches | Legit max |
| --- | --- | --- | --- | --- |
| Fast | SUM ≥ 25 | 5 min, 1 datapoint | hard loops; fires ~5–6 min into a real runaway | ~7–14 |
| Hourly | SUM ≥ 60 | 1 hour | drips that stay under 25/5min | ~25–30 |
| Daily | SUM ≥ 150 | 24 h (built from short periods — see gotchas) | slow grind; backstop for a partial trip | well under 150 post-caps |

- The fast tier exists because research showed a 1-hour-period alarm has a multi-minute firing floor plus evaluation-range dilution — without the 5-minute tier the "stop within minutes" goal fails for moderate runaways.
- **Error alarms are explicitly NOT breaker triggers.** They fire on ≥1 error line; a single vendor hiccup must never kill the project. They stay notification-only on the enricher topic.
- **AWS Budgets stay email-only.** Billing data lags 7–33h (≤24h to become a billing record + Cost Explorer's ≤3×-daily refresh), and Budgets Actions support only IAM policy / SCP / EC2-RDS stop — they cannot disable schedules or set Lambda concurrency. Budgets are the slow fleet-wide backstop, not a trigger.

### Layer 4 — The breaker Lambda (shared-infra)

**Trigger topology:** a dedicated `shared-infra-costbreaker` SNS topic. Only tripwire alarms publish to it; the breaker subscribes; the enricher also subscribes (so every trip still emails). A destructive actuator must be physically unreachable by ordinary alarms — routing is enforced at the CloudFormation `AlarmActions` level, not by an SNS filter policy that can silently typo. Loop prevention is structural: the breaker's own notifications go to the *enricher* topic, never the breaker topic, so it cannot re-trigger itself; the sticky state param is the second, redundant guard.

**Targeting:** convention-based discovery. Extract the project prefix from the alarm name (`stocktextalerts-…` → `stocktextalerts`), then `ListFunctions`/`ListSchedules` filtered to `<project>-*` — mirroring the enricher's existing log-group discovery convention rather than introducing a second source of truth (a static manifest) that drifts when functions are added. Discovery errors are bounded by IAM: the breaker role's mutating permissions are scoped to the fleet project prefixes only.

**Trip actions (per-project blast radius; idempotent — no-op if state param already set):**

1. `PutFunctionConcurrency(0)` on every discovered function — the canonical AWS kill switch, covers all entry points (cron, Lambda URL, SQS).
2. `UpdateSchedule State=DISABLED` on every discovered schedule — stops the per-minute event pile-up so the tripped state is quiet and the re-arm backlog stays small. Must `GetSchedule` and replay all fields first (see gotchas). All three crons are `ScheduleV2` → EventBridge Scheduler; `DisableRule` is not used anywhere.
3. Write sticky tripped state to SSM (`/breaker/<project>/state`).
4. **Post-trip self-verification:** re-read concurrency on each target; any target not actually at 0 gets a loud `FAILED TO THROTTLE` line in the email.
5. One deliberate email via the enricher topic with the full act-list and per-resource success/failure.

**Failure posture:** independent best-effort per resource — one failed API call must not block killing the rest (partial stop beats no stop). The independently-evaluating daily tripwire catches a partially-stopped leak. The breaker has its own invocation/error alarms (wired to the enricher topic, like the enricher's own self-monitoring).

**Escalation:** if a trigger is account-level (cannot be attributed to a project — e.g., a future account-budget signal), the breaker kills the whole fleet. Granularity has already lost its meaning at that point.

**IAM:** a new purpose-built role. The existing `agent-deploy` role explicitly denies infra mutation and must not be widened. Breaker role grants: `lambda:PutFunctionConcurrency`/`GetFunctionConcurrency`/`ListFunctions`, `scheduler:GetSchedule`/`UpdateSchedule`/`ListSchedules`, `ssm:GetParameter`/`PutParameter` on `/breaker/*`, `sns:Publish` to the enricher topic — all resource-scoped to fleet prefixes where the API allows.

### Layer 5 — Manual re-arm + validation

**Re-arm is manual only** (`rearm.sh <project>` in shared-infra, run with admin creds after diagnosis). Auto-re-arm after a cooldown was rejected: the alarm clears *because nothing is sending*, so auto-re-arm restarts the runaway every cooldown — a slow-motion loop.

Re-arm steps: restore reserved concurrency to the canonical template values (one source of truth: the SAM template) → `GetSchedule`-replay with `State: ENABLED` → **flush stale work before traffic resumes**: mark `scheduled_notifications` still pending and older than ~2h as expired, so recovery doesn't open with a burst of yesterday's messages → clear the SSM param. A short runbook (`docs/breaker-runbook.md`) covers diagnosis: volume metric graph → offending type in `notification_log` → fix → re-arm.

The stale-flush is **load-bearing, not hygiene**: concurrency=0 stalls rather than discards queued work. The minute-cron's async invokes are re-queued as retryable 429s for up to 6h and *replay on re-arm*; SQS messages wait out visibility timeouts and route to the DLQ at maxReceiveCount=5 (DLQ already configured — the safe arrangement).

**Validation:**

- Dry-run mode (`BREAKER_DRY_RUN=true`): full discovery, act-list, email — no mutating calls. Used for iterating on routing/discovery safely.
- Manual-trip script (`trip-breaker.sh <project>`): deliberate trip for drills and real incidents; doubles as the test harness.
- **Live takedown drill: Saturday 2026-06-13 ~19:00 UTC (3pm ET).** The 17:00–21:59 UTC Sat/Sun block has zero sends across 60 days of history; market closed; ~3h clearance on each side (next activity: 22:00 UTC digest cluster); operator awake. Trip stocktextalerts for real, verify concurrency=0 + schedules disabled + email correct, run re-arm, confirm the 22:00 digests fire normally. This replaces a synthetic canary test — it proves the actual prod path under controlled conditions. **The drill gates only the breaker (Layers 3–4); it requires the breaker deployed and armed before Saturday, else the drill slides to the next weekend's same window.**

## Implementation gotchas (research-verified, primary AWS sources)

1. **Sparse metrics never alarm by default.** `defaultValue: 0` on the metric transformation + `treatMissingData: notBreaching`, or the tripwires sit in `INSUFFICIENT_DATA` forever.
2. **`UpdateSchedule` is a full overwrite.** Any optional field omitted (timezone, retry policy, flexible window, start/end dates) silently resets to system default. The breaker and re-arm must `GetSchedule` and replay every field. Our schedules are simple (`rate`/`cron`, one target, role ARN, `FlexibleTimeWindow: OFF`), and a SAM redeploy (`npm run deploy:aws`) always restores canonical config as the ultimate fallback.
3. **concurrency=0 stalls work; it does not discard it.** Async invokes retry up to 6h with backoff and replay on re-arm; SQS retries until visibility timeout, then DLQs (with redrive configured — ours is). Hence the mandatory stale-flush on re-arm.
4. **Alarm latency floor is minutes, not seconds.** Standard alarms evaluate once per minute; end-to-end ≈ metric lag + (datapoints × period). Long-period alarms also pull an evaluation range ~3× the period, so a single breaching datapoint can be diluted into OK — the daily tripwire must be built from shorter periods with multi-datapoint evaluation, not one naive 24h period. Claims that high-resolution alarms give sub-minute log-metric tripwires were refuted in verification (0–3).

## Alternatives considered and rejected

- **AWS Budgets Actions as the remediation engine** — can't touch schedules or concurrency; 7–33h billing lag. Email-only backstop instead.
- **Wiring existing error alarms to the breaker** — fires on a single error line; would nuke the project on routine vendor blips.
- **Invocation-count gating instead of concurrency caps** — cron invocation rate is fixed by the scheduler and doesn't move during a runaway; detection-after-alarm vs. enforcement-at-zero-latency.
- **Schedule-disable only (no concurrency=0)** — misses the Lambda-URL and SQS entry points. **Concurrency-only (no schedule-disable)** — async events pile up for 6h and replay as a large backlog. Both actions together: hard kill + quiet state.
- **SNS filter policy on the shared topic instead of a dedicated breaker topic** — filter-policy typos fail silently in both directions on a destructive actuator.
- **Static kill manifest** — drifts the moment a function is added; the `<project>-*` naming convention is already load-bearing fleet-wide.
- **In-app global Grok budget counter** — triple coverage for a surface already bounded transitively (Layer 1) and financially (Layer 0); permanent maintenance for marginal value.
- **Twilio subaccount + usage-trigger webhook auto-suspend** — Twilio's documented anti-fraud pattern; right at 10k users, machinery-for-machinery's-sake at 11.
- **Auto-re-arm after cooldown** — restarts the runaway on a timer.

## Acceptance criteria

1. A simulated hard loop (≥25 SMS within 5 min) trips the fast alarm and the breaker fully stops the project — concurrency 0 on all functions, all schedules disabled, SSM state set, one email with a complete and accurate act-list — within ~10 minutes of the first excess send.
2. A tripped project produces exactly one breaker email plus one transition burst from affected alarms; no recurring notifications while tripped; breaker re-invocation is a no-op.
3. The 2026-06-08 incident replayed against Layer 1 yields ≤5 flat-alert SMS for that user/symbol/day, with suppressed sends visible in logs.
4. No user can receive more than 40 SMS in a day through any code path that uses the send wrapper.
5. Re-arm restores schedules byte-equivalent to the SAM-deployed config (verified by GetSchedule diff), restores template concurrency values, expires stale pending notifications, and the next scheduled sends fire normally.
6. The live takedown drill (Sat 2026-06-13 ~19:00 UTC or next weekend's equivalent) passes end-to-end, including post-trip self-verification output and recovery of the 22:00 UTC digests.
7. Tripwire alarms demonstrably leave `INSUFFICIENT_DATA` (sparse-data config verified in prod) and the daily alarm is shown to fire on a synthetic slow drip in dry-run.
8. Worst-case dollar exposure with every code layer failed is bounded by provider caps: ~$100 Twilio + (balance + $10/mo) xAI.

## Sequencing

Layers 0–2 are independently shippable now and remove most of the risk: Layer 0 is **already done**, Layer 1 is a stocktextalerts migration + send-path check, Layer 2 is five lines of SAM template. Layers 3–4 (metric, topic, breaker, IAM, dry-run, drill) are the bigger build across both repos and are gated by the weekend drill. Layer 5's scripts/runbook land with Layer 4.

Implementation plans (per repo convention): `docs/plans/2026-06-11-cost-guardrails-app-layers.md` (stocktextalerts, Layers 1–3) and a shared-infra counterpart for the breaker (Layer 4–5), each referencing this spec.

## Sources

Verified via adversarial multi-source research (23/25 claims confirmed, 2 refuted), primary AWS documentation throughout:

- Lambda reserved concurrency / kill switch: <https://docs.aws.amazon.com/lambda/latest/dg/configuration-concurrency.html>
- Async throttle/retry behavior: <https://docs.aws.amazon.com/lambda/latest/dg/invocation-async-error-handling.html>
- SQS error handling under throttle: <https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-errorhandling.html>
- Scheduler state management: <https://docs.aws.amazon.com/scheduler/latest/UserGuide/managing-schedule-state.html>
- UpdateSchedule full-overwrite: <https://docs.aws.amazon.com/scheduler/latest/APIReference/API_UpdateSchedule.html>
- Alarm evaluation & missing data: <https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/alarms-and-missing-data.html>, <https://repost.aws/knowledge-center/cloudwatch-alarm-invoke-issues>
- Budgets Actions limits: <https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-controls.html>
- Billing-data latency: <https://aws.amazon.com/aws-cost-management/aws-cost-anomaly-detection/faqs/>, <https://github.com/aws-solutions/innovation-sandbox-on-aws/issues/92>
- Twilio anti-fraud usage triggers (rejected alternative): <https://www.twilio.com/docs/usage/anti-fraud-developer-guide>
