# Messaging follow-ups (deferred from the consistency sweep)

**Date:** 2026-06-24
**Branch:** worktree-messaging-followups
**Predecessor:** docs/plans/2026-06-24-e2e-messaging-consistency.md (shipped 82f5b596)
**Status:** All five implemented. Two migrations
(`20260624212024_claim_returns_attempt_count`, `20260624213606_email_dispatch_idempotency_ttl`)
bump `schema_version` + `EXPECTED_DB_SCHEMA_VERSION`. Full battery green: biome, knip, ts,
squawk, migration-grants, db-privileges (20 functions), deploy-functions, 1019 vitest, build.

## Spec

Implement the five items deferred from the E2E messaging consistency sweep. Two carry
migrations (ride the pre-push `supabase db push`). No user-facing behavior change beyond the
deliberate display/footer unification.

## Items

### F1 — fmt-0: unify price thousands-separators

Two conventions exist: `asset-formatting.ts` uses `$${n.toFixed(2)}` (no separators); the
Telegram renderers + `price-targets/delivery.ts` use `toLocaleString` (separators). Unify to
**thousands-separators everywhere** (the financial-standard, more readable for high-priced
names) via a shared `formatUsdPrice(n)` + `formatSignedChangePercent(n)` in
`asset-formatting.ts`. Align the sign threshold to `>= 0`. Update exact-string tests.

### F2 — fmt-4: per-channel footer/disclaimer contract

Footers diverge: Telegram has "Not financial advice." but no opt-out; SMS/email have opt-out
but no disclaimer; price-alert Telegram has neither. **Contract: every channel gets BOTH a
disclaimer ("Not financial advice.") AND an opt-out/manage path.** Centralize the disclaimer
string; add it to SMS + email footers; add a `/stop`-to-pause hint to the four Telegram
renderers (mechanism already exists). Propagating established phrases, not new compliance copy.

### F3 — ineff-5: per-pass logo cache

Logos have inFlight concurrent dedup but each user builds a fresh `LogoCache`. Create one
`LogoCache` per cron pass (in `run.ts`), thread it into the market-scheduled + asset-events
processors (and daily-digest dispatch) so a symbol's logo resolves at most once per pass.

### F4 — ineff-3: claim RPC returns attempt_count (migration)

`claim_scheduled_notification` denies → `claimNotification` re-SELECTs attempt_count, then
`updateScheduledNotificationRow` re-SELECTs it AGAIN on a failure. Have the claim RPC return the
post-claim attempt_count (migration); thread it through `claimNotification` →
delivery functions → `updateScheduledNotificationRow` to drop the redundant SELECT. Re-grant +
re-classify the changed function in `privilege-contract.ts`.

### F5 — esf-2: email-dispatch idempotency TTL + safe release

`email_dispatch_idempotency` has no TTL, so "keep the claim on ambiguous SES failure" would
suppress an auth email forever. Migration: add `expires_at` (now() + 24h) + a claim that
**re-claims an expired key** (so a kept claim self-heals after the window). Then in
`email-dispatch.ts`: release the key only on **provably-not-sent** outcomes (signature/parse
rejection, pre-send authorization failure); on an ambiguous SES send failure, KEEP the claim so a
retry collapses to "duplicate" instead of double-sending — the claim TTLs out for a later retry.

## Validation

- check:ts / biome / knip / sql (squawk) / migration-grants / db-privileges + full vitest + build.
- Two migrations bump `app_metadata.schema_version` + `EXPECTED_DB_SCHEMA_VERSION`; regen types.
- Live-affecting (notification content) → post-deploy `stocktextalerts-live-provider-check`.
