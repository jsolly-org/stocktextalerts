# Fix: live-provider-check Lambda hangs 300s on the Telegram health check

**Date:** 2026-06-21 · **Status:** Build-ready · **Branch:** `worktree-telegram-healthcheck-timeout`

## 1. Spec

### Problem

The scheduled `stocktextalerts-live-provider-check` Lambda (`src/handlers/live-provider-check.ts`)
times out at its full **300s** ceiling on **every** invocation, returning `Sandbox.Timedout` /
`FunctionError: Unhandled`. Its `ScheduleV2` trigger (WeekdayMidSession, Mon–Fri 16:00 UTC) therefore
fires `LiveProviderCheckFunctionErrorAlarm` → shared-infra SNS → operator email on every weekday run.

This is a **pre-existing** bug, not caused by the `deploy_code` change that surfaced it.

### Evidence (CloudWatch, `/aws/lambda/stocktextalerts-live-provider-check`)

- 2026-06-19 16:00 (gitSha `cb58d27d`): **PASSED in 3.15s**, 4 checks, no Telegram check.
- 2026-06-21 (gitSha `228cb5df`): every run `Status: timeout` at 300000ms. Logs show the `Lambda invoke`
  line, then nothing until the REPORT line — a silent hang.
- The only delta is commit `c8833188`, which added check #5, `telegram:get-me`.
- Reproduced live (manual invoke 2026-06-21): `Sandbox.Timedout` at 300.00s.

### Root cause

`checkTelegramLive` (`src/lib/messaging/telegram/health.ts`) calls grammY's `getMe()` + `getWebhookInfo()`
with no timeout. Two things compound:

1. **grammY 1.44 uses `node-fetch@2`** → Node's native `http`/`https` stack with a keep-alive
   `https.Agent`. The working Massive/Finnhub checks use the global **`fetch`/undici**.
2. `api.telegram.org` publishes **AAAA (IPv6)** records, but a Lambda **outside a VPC has IPv4-only
   egress**. undici does Happy-Eyeballs IPv4 fallback (proven: `finnhub.io` also has AAAA and works);
   node-fetch's native-https path stalls on the unroutable IPv6 attempt with no fallback. grammY's own
   request timeout defaults to **500s** > the 300s ceiling, so it never self-aborts → silent 300s hang.

The schedule Lambda shows **zero** Telegram sends in 5 days → the channel has no subscribers yet, so this
health check is the **first real grammY→Telegram call in prod**. The production **send path shares the
same `createTelegramBot` factory** and the same broken stack — a latent bug that would bite the first
Telegram subscriber.

## 2. Fix

All in `createTelegramBot` (shared by health check **and** real sends, so the check stays representative —
no false-green) plus the handler:

1. **IPv4-pin the agent** — `new https.Agent({ keepAlive: true, family: 4 })` in grammY's
   `client.baseFetchConfig`, forcing DNS to A records. Root-cause fix for both the health check and real
   sends. (Routing grammY through undici is **not** viable: grammY never sets `duplex`, so undici would
   reject the streamed `sendPhoto` body.)
2. **Bound grammY's request timeout** — `client.timeoutSeconds` (25s default; 10s for the health check),
   replacing grammY's 500s default so a stalled call can never burn a whole invocation.
3. **Hard backstop in `checkTelegramLive`** — a `Promise.race` against a 12s timeout that rejects with a
   clear message, so the check fails fast even if grammY's own abort wedges.
4. **Per-check timing logs** in the handler's `runCheck` — the original logged nothing per check, so the
   hang was invisible. A slow/failing provider is now attributable from logs alone.

### Tests

`tests/lib/messaging/telegram-health.test.ts` gains a timeout-path case: a transformer-mocked bot whose
probes never settle must reject with the timeout error in tens of ms, not hang.

## 3. Verification

- Local: `check:ts`, `check:biome`, affected unit tests, pre-push gate.
- Prod (post-deploy): invoke `stocktextalerts-live-provider-check` via the `fleet-deploy` profile; confirm
  it returns success (no `FunctionError`) well under 300s, and per-check timing logs show the Telegram
  check completing in seconds. Run during market hours for fresh snapshot data.

## 4. Follow-up

The fix already covers the production send path (same factory). Once a real Telegram user subscribes,
confirm a real send lands (the one-time manual `/start` E2E) to validate the IPv4 pin end-to-end on the
data plane, not just the `getMe`/`getWebhookInfo` control plane.
