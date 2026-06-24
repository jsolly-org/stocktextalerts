# E2E messaging pipeline: consistency & efficiency sweep

**Date:** 2026-06-24
**Branch:** worktree-e2e-messaging-consistency

## Spec

**Goal:** Remove cross-type inconsistencies and redundant per-minute work from the E2E
notification messaging pipeline (6 notification types × 3 channels) without changing
user-visible behavior except where a channel was demonstrably wrong.

**Problem:** A multi-agent audit (9 slice maps → 7 dimension finders → adversarial verify →
synthesis) confirmed 28 findings. The pipeline is fundamentally sound; almost all findings are
*consistency drift* between the six notification types and three channels, plus a handful of
redundant fetches and one genuine opt-out bug.

**Acceptance:**

- Price-target + anomaly-price-alert emails respect the global `email_notifications_enabled`
  kill-switch (matching the 4 sibling types).
- Telegram is counted/handled consistently in every failure-guard, recovery-log, and Grok gate.
- Price-target delivery accounting no longer conflates delivery failures with log-write
  failures; `error_code` is recorded on every channel.
- A permanently-failing price target stops re-sending every market-minute (retry ceiling) and a
  single channel's success no longer drops a transiently-failed sibling channel.
- Redundant per-minute work removed: per-pass logo cache, capture-map merged into the quote
  cache, per-tick intraday-bar memo, no daily-digest refetch.
- `npm run check:biome`, `check:ts`, `check:knip`, and the affected vitest suites pass.

## Theme → task map (28 findings)

### T1 — Email opt-out compliance (HIGH) — findings gating-0, channel-consistency-0, gating-1

Price-target (`price-targets/delivery.ts:140`) and anomaly price-alert
(`market-notifications/delivery.ts:251`) email branches gate on the per-option facet only,
ignoring the global `email_notifications_enabled` flag that the other 4 types enforce. A user
who turned email off globally still gets these emails if a stale per-option facet remains on
(reachable via the Telegram pre-filter clause / the no-channel-prefilter price-targets query).
Fix: add a shared `isEmailChannelUsable(user)` helper (mirrors `isSmsChannelUsable`/
`isTelegramChannelUsable`), gate both delivery functions on it, add `email_notifications_enabled`
to `PriceTargetUser` interface + SELECT + `hasEnabledChannel`.

### T2 — Telegram counter/recovery consistency — esf-6, totals-5, esf-0/dedup-1, channel-consistency-1

- `scheduled/process.ts:422` false-negative guard omits telegram from the delivery-attempt sum.
- `daily-digest/process.ts:225` Grok send-counter gate omits `telegramSent` (staged path includes it).
- `daily-digest/schedule-state.ts:181` failure recorder hard-codes `["email","sms"]`, dropping telegram-only users.
- Telegram renderers never get the delay banner email/SMS get → thread it (or document the omission).

### T3 — Price-target delivery accounting — totals-2, totals-1

- `process.ts:352` counts delivery exceptions as `logFailures`; add a `deliveryErrors` field instead.
- `delivery.ts:170,206` email/sms log rows drop `error_code`; use `deliveryResultToLogFields(result)`.

### T4 — Price-target retry-ceiling + per-channel terminal (migration) — esf-1, dedup-2

Migration adds `attempt_count` + `next_retry_at` to `price_targets`. Track per-channel terminal
state so one channel's success doesn't delete the row and drop a transiently-failed channel;
stop re-sending after a max attempt count (tombstone + error log on exhaustion). Mirror the
`updateScheduledNotificationRow` backoff pattern in `schedule/helpers.ts`.

### T5 — Efficiency: per-pass caches + reduced refetch — ineff-0,1,2,3,5

- Per-pass `LogoCache` threaded into processors (currently rebuilt per user).
- Merge `captureQuoteMap` into `schedulerQuoteCache` after the price-history capture fetch.
- Per-tick `fetchIntradayBars` symbol memo (currently O(users×symbols)).
- Daily-digest fan-out reuses the already-loaded user+prefs instead of refetching.
- `claim_scheduled_notification` returns post-claim `attempt_count` to skip the re-SELECT (migration).

### T6 — Content/formatting consistency — fmt-0,1,2,3,4

- Shared price/percent formatters for the Telegram renderers (align sign threshold + precision).
- Unify change-% precision to 2 decimals fleet-wide.
- One market-closed banner builder with optional `asOf`; digest passes its quote timestamp through it.
- Per-channel footer contract (opt-out line on Telegram; "not financial advice" on SMS/email if desired).

### T7 — Idempotency + silent-failure hardening — dedup-0, esf-2, esf-4, totals-0, totals-4, gating-2

- **dedup-0 DECISION:** the `idempotencyKey` param on the direct-SES `sendUserEmail` path is
  inert (only the dispatch-Lambda path reads it). **Remove the dead param** from `sendUserEmail`
  - `processEmailUpdate` + the flat-alerts/staged call sites, and correct the misleading
  "SES dedup collapses it" comments to state the truth (the upstream claim CAS is the sole
  dedup). A real email-level idempotency backstop (claim/release against
  `email_dispatch_idempotency` at the notification send sites) is a worthwhile *follow-up* but is
  a design change with its own failure modes (orphaned claims, TTL) — out of scope here, where
  the goal is to stop the code implying a guarantee it does not provide.
- esf-4: `purgeStaleStaged` swallows delete errors → surface them; log at warn/error on failure.
- esf-2: email-dispatch key released in a blanket `finally` on ambiguous SES outcome → release
  only on provably-not-sent branches; let ambiguous failures TTL out.
- totals-0: sender-resolution failure writes a `notification_log` row on only one path →
  standardize (apply everywhere or nowhere; pick the audit-row-everywhere convention).
- totals-4: real-time alert paths count SMS-ineligible users as `smsFailed`; route to `skipped`.
- gating-2: document the Telegram one-flag opt-out model at the write site + eligibility helper.

## Notes

- Migrations: T4 (`price_targets` columns) — local file only; prod apply rides the pre-push
  `supabase db push`. Bumped `app_metadata.schema_version` + `EXPECTED_DB_SCHEMA_VERSION` + regen
  types. New columns inherit table grants (no privilege-contract change).
- Live-affecting: touches `providers/`, notification content, and delivery paths → after deploy,
  invoke `stocktextalerts-live-provider-check` and confirm no alarm.

## Final dispositions (what shipped vs. deferred vs. surfaced)

**Shipped (24 of 28 findings):**

- T1 — gating-0, gating-1, channel-consistency-0: `isEmailChannelUsable` helper; both leaking
  email paths gated on the global flag; `email_notifications_enabled` added to `PriceTargetUser`.
  - a regression test.
- T2 — esf-6, totals-5, esf-0/dedup-1: Telegram folded into the false-negative guard, the Grok
  send gate, and the daily-digest failure recorder (channel set now derived from enabled channels).
- T3 — totals-2, totals-1: `deliveryErrors` counter; `deliveryResultToLogFields` for error_code.
- T4 — esf-1, dedup-2: migration `20260624172838`; per-channel terminal tracking + retry ceiling +
  backoff; ineligibility → skipped (not a blocker). + 3 behavior tests.
- T5 — ineff-2, ineff-0, ineff-1: capture map seeds the scheduler quote cache; daily-digest
  dispatch reuses the loaded `UserRecord`; `fetchIntradayBars` gains inFlight concurrent dedup.
- T6 — fmt-1 (documented the deliberate 1-decimal headline convention); fmt-3+fmt-2 (digest now
  renders the shared market-closed banner across all channels — with the "as of" staleness hint
  extended from email-only to SMS+Telegram; deleted the local duplicates); fmt-0 sign-alignment
  (Telegram `>0`→`>=0` matching the canonical formatter); channel-consistency-1 (threaded the
  delay banner into all three Telegram renderers — Telegram users now see "your notification is
  late" like email/SMS). + tests for the SMS asOf and the Telegram delay banner.
- T7 — dedup-0 (removed the inert `idempotencyKey` from the direct-SES path + corrected the false
  "SES dedup" comments), esf-4 (purge throws instead of swallowing), totals-4 (SMS-ineligibility
  uncounted fleet-wide), totals-0 (sender-resolution catches no longer write a notification_log
  row — consistent), gating-2 (documented the Telegram one-flag opt-out model).

**Deferred — disproportionate risk/effort for LOW value (documented, not done):**

- esf-2 (email-dispatch key release): prescribed fix ("keep claimed on ambiguous SES failure, let
  it TTL out") is UNSAFE as-is — `email_dispatch_idempotency` has no TTL/purge, so keeping a claim
  would PERMANENTLY suppress an auth email. Needs a TTL/purge design first.
- ineff-3 (claim RPC returns attempt_count): RPC-contract change + migration to remove one SELECT
  on the failure path only. Smallest win, hottest path.
- ineff-5 (per-pass logo cache): logos already have inFlight concurrent dedup (now matching
  intraday); threading a shared cache through three processor signatures isn't justified.

**Follow-up — deferred to a focused, deliberate pass:**

- fmt-4 (footer contract): broader than estimated — footers are scattered across email-text,
  email-HTML, several SMS formatters, and four Telegram renderers (price-alert Telegram has NO
  disclaimer at all), with no central source. Needs (a) a one-time centralization refactor and
  (b) a per-channel compliance-copy contract (disclaimer everywhere? opt-out hint format? SMS
  char-budget wording?) — a deliberate change with sign-off, not a tail-end bolt-on.
- fmt-0 (price thousands-separators): `toLocaleString` (Telegram/price-targets) vs `toFixed`
  (email/SMS). Cosmetic, invisible for sub-$1000 prices, and changing the core `asset-formatting`
  formatter risks breaking exact-string tests for low value. The trivial sign-at-zero half WAS
  done; the separator-convention choice is left as documented.
