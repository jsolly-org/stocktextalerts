# Telegram-native notification channel

**Date:** 2026-06-19 · **Status:** Revised post adversarial-review — build-ready · **Branch:** `telegram-channel`

> Revision note: this plan was hardened by a 6-lens adversarial review against the codebase. The
> blockers it found (migration apply order, preference mis-modeling, destructive column drops, inbound
> security, native-binary bundling, release sequencing) are folded in below. The candlestick blocker
> (P0-1) was **resolved by a spike**: Massive's aggregates already return full OHLC and a daily parser
> (`extractOHLCVFromBars`, `src/lib/providers/massive.ts:560`) already exists — the intraday path just
> discards `o/h/l`. Candlesticks stay in v1 with a small intraday-OHLCV parser task.

## 1. Spec

### Goal

Add Telegram as a **first-class** notification channel — not an SMS port. Telegram becomes the
**canonical** alert surface (entity-formatted text, candlestick chart images, inline-button actions) plus
a **two-way control plane**. SMS and email are reframed as **down-renders** of the canonical artifact.
Long-term, migrate users onto Telegram **without forced deprecation**; email/SMS remain floors.

**Guiding bias (user, 2026-06-19):** for this channel, prioritize a **first-class experience over
dependency-minimalism** — add deps freely when they materially improve UX/quality (grammY menu/
conversations/hydrate plugins, a charting lib for clean candlesticks, etc.). This deliberately overrides
the repo's general "fewer dependencies" code-style default, scoped to Telegram.

### Problem

SMS is today's lowest common denominator (per-segment cost → terse copy, URL shortener, 280-char summary
cap). Each channel re-derives presentation from loosely-shared inputs across 8+ dispatch sites; there is
no single artifact. The `{type}_include_{channel}` boolean matrix (22 columns) does not scale to a third
channel — and is **not** a clean `type×channel` grid (news/rumors are email-only; SMS strips them).

### Non-goals (v1)

- Native Telegram-only signup (Telegram ID as identity, no email) — **Phase 5**.
- Live-editing messages (`editMessageText` "FLASH" thread) — **Phase 5** (locked §10).
- Telegram Stars/payments, public broadcast channels, inline-mode, group watchlists — future seeds.
- **i18n** — v1 is **English-only** (bot copy, commands, disclaimer); i18n is a future seed.

### Acceptance criteria

1. A logged-in user links Telegram via a signed deep-link and receives **every** existing notification
   type rendered natively (neutral-wire voice, `fmt` entities, **candlestick chart on single-asset
   alerts**).
2. SMS and email continue to send, now produced as down-renders of the canonical artifact, with the
   existing formatter test suites passing **byte-identical** (no segment/URL/email-table regression).
3. The bot answers `/start` (link), `/quote`, `/watch`/`/unwatch`/`/list`, `/mute`, `/stop`, `/unlink`,
   `/help`, with inline-keyboard config; every callback is `answerCallbackQuery`'d and ownership-checked.
4. Outbound fan-out survives Telegram rate limits (grammY `auto-retry` honors `retry_after`; no double
   retry); webhook dedupes on `update_id`, fails closed on bad/absent secret, and returns 2XX fast.
5. Blocking the bot (outbound 403) flips `telegram_opted_out`; preferences live in the normalized table
   (old columns retained + dual-written in v1); full migration + grant + RLS + `schema_version`
   checklist passes; the release ships via the documented merge → `deploy:aws` → enable order.

## 2. Research-driven decisions (verified)

| Decision | Resolution | Source |
| --- | --- | --- |
| Framework | **grammY** | grammy.dev/guide/deployment-types |
| Webhook hosting | **Astro/Vercel route** `/api/messaging/telegram` (thin 2XX ack, mirrors Twilio inbound). Outbound sender = shared lib imported by Lambda crons (parallels SMS **inline** model, not the email-dispatch HTTP model). | grammy.dev, `src/middleware.ts:186` |
| Fan-out | **No artificial pacing.** Sequential, bounded concurrency (~3), grammY `auto-retry` honors `retry_after`; never ignore 429. Free-tier ~30 msg/s global, ~1 msg/s per chat. | grammy.dev/advanced/flood, core.telegram.org/bots/faq |
| Retry ownership | **grammY `auto-retry` solely owns 429/`retry_after`.** Telegram is **excluded** from `withDeliveryRetry`'s 429 path (else double-retry → ban). Cap retry delay so one 300s tick can't be blocked. | grammy.dev/plugins/auto-retry, `delivery-retry.ts:53` |
| Webhook auth | `setWebhook` `secret_token` → `X-Telegram-Bot-Api-Secret-Token`, **fail-closed** (500 if `TELEGRAM_WEBHOOK_SECRET` unset); `timingSafeEqual` if grammY's compare isn't constant-time. | core.telegram.org/bots/api, `dispatch-auth.ts:36` |
| Idempotency | Webhook returns 2XX fast; **dedupe on `update_id`** (Telegram retries non-2XX/timeouts). Scheduled sends use the existing `claim_scheduled_notification` RPC with `p_channel='telegram'` (the param is the `delivery_method` **enum** — no signature/contract change). | grammy.dev/guide/deployment-types, migration `...sql:335` |
| Text formatting | grammY **`parse-mode` `fmt`/`FormattedString`** entity API — no MarkdownV2/HTML escaping. | grammy.dev/plugins/parse-mode |
| Charts | **Candlesticks** via `buildCandlestickSvg` (new) → **resvg-js** PNG. OHLC already in the Massive payload; add an **intraday OHLCV parser** mirroring `extractOHLCVFromBars` (`massive.ts:560`). resvg `.node` shipped via `External` + layer/include (P0-9). Render is **cron/outbound-only** — never on the webhook path. | `massive.ts:455,560`, github.com/thx/resvg-js |
| Callbacks | `answerCallbackQuery` on **every** press. Callbacks are **unsigned** → authorize by `resolveTelegramUser(from.id)` + re-derive/own-check the target object; bind a signed single-use nonce into `callback_data`. | grammy.dev/plugins/keyboard |
| Conversations | grammY `conversations` is in-memory and dies between invocations → official **Supabase storage adapter**; obey replay model (side effects in `conversation.external`). | grammy.dev/plugins/conversations, github.com/grammyjs/storages |
| Preferences | **Normalized `notification_preferences`**, but **keep the 22 columns + dual-write in v1**; drop in a later migration after reads migrate. Backfill per-column (not cross-join). Content-richness (news/rumors/citations) is a **separate facet dimension**, not a channel toggle. | dossier §3, `process.ts:607` |
| Onboarding | **Link-only**, signed-token (`{userId,expiresAtMs,nonce}` HMAC, user_id is the signed subject), atomic single-use consume, no fail-open. | dossier §4 |

### Spikes still open (resolve in Phase 0, do not assume cleared)

- `editMessageText` rate limit + `"message is not modified"` handling — only if Phase-5 live-edit proceeds.
- Telegram Login Widget hash validation + Supabase integration — Phase 5.
- grammY Bot-API mocking pattern for tests — resolve before Phase-1 test-writing.

## 3. Architecture

```
 price/event data ─► CanonicalAlertArtifact (single enforced input; carries LONG urls + OHLC series)
                          │
        ┌─────────────────┼──────────────────┐
        ▼                 ▼                  ▼
  Telegram renderer  Email down-render   SMS down-render
  (fmt entities,     (html/text,         (text + segment-pad
   candlestick PNG,   own sparkline)      + OWN url-shorten)
   inline keyboard)
        │
        ▼  outbound sender lib (grammY Bot + auto-retry + bounded concurrency, !isProduction() mock)
        │     imported INLINE by Lambda crons (like SMS; NOT via an HTTP dispatch fn)
        ▼  Telegram Bot API

 Inbound (control plane): Telegram ─► /api/messaging/telegram (Astro/Vercel, thin, fail-closed secret)
   grammY webhookCallback({ secretToken }) → update_id dedupe → fast 2XX
   → resolveTelegramUser(from.id) → command/callback handlers (service_role; EVERY write scoped by user_id)
   → conversations plugin (Supabase storage) for multi-step config.   NEVER renders charts here.
```

- Canonical artifact carries the **long** URL; each renderer owns its own shortening (SMS keeps the
  shortener mock in tests; Telegram/email don't need it).
- Don't extend `toSvgSparklineImg` (returns an email `<img>`, pinned by `svg-sparkline.test.ts`) — add a
  separate `buildCandlestickSvg` + `renderChartPng` so email tests stay byte-stable.

## 4. Phase 0 — Foundations (no user-visible change)

### 4.1 Bot + secrets (human step-up)
- You create the bot via BotFather, set name/about/commands, mint the token. Token is a **write
  credential**: Vercel env **and** Lambda CFN param only; **never** local/test; **excluded** from
  `live-provider-check`.
- **Secret matrix (both runtimes):** `TELEGRAM_BOT_TOKEN` + `TELEGRAM_WEBHOOK_SECRET` exist in Vercel
  (webhook verify/reply/setWebhook) and Lambda (outbound). Add both to `src/types/env.d.ts` (mirror
  `TWILIO_AUTH_TOKEN`), to `aws/template.yaml` Parameters (NoEcho) + per-function Environment, and to
  `aws/sam-params.sh` with `:?` guards. Rotation = one runbook touching both runtimes + re-run setWebhook.

### 4.2 Dependencies + native-binary build (P0-9)
- `grammy`, `@grammyjs/auto-retry`, `@grammyjs/conversations`, `@grammyjs/storage-supabase`,
  `@resvg/resvg-js`. Platform-targeted install (`--os=linux --cpu=arm64`).
- **esbuild cannot bundle `.node`** → add resvg packages to each rendering function's
  `Metadata.BuildProperties.External` **and** ship the platform `.node` via a Lambda layer or a
  makefile/manual include copying `node_modules/@resvg/*` into the artifact.
- **Spike outcome (2026-06-19):** `@resvg/resvg-js@^2.6.2` installed; renders a line chart to a valid
  PNG locally (1004 bytes, correct PNG magic). `@resvg/resvg-js-linux-arm64-gnu@2.6.2` (the Lambda
  target) confirmed published via the standard optionalDependencies mechanism. `sharp` is only a
  transitive (Astro build-time) dep — not reusable in the cron Lambda. **Decision:** proceed with the
  `External` + bundled-`node_modules` approach; fold the final bundling proof into the first
  (human-gated) `deploy:aws` + `aws lambda invoke`, with a **Lambda-layer fallback** ready if esbuild's
  External packaging drops the `.node`. Residual risk is low (binary published, standard napi mechanism,
  External is a documented pattern), and the rigorous proof is gated on the human deploy regardless.

### 4.3 Migration — split into ordered files (P0-3, P0-5)
- **File 1 (alone):** `ALTER TYPE public.delivery_method ADD VALUE IF NOT EXISTS 'telegram';` (must
  commit before any use). No CHECK/contract change — `p_channel` is the enum.
- **File 2:**
  - `notification_preferences` table. **RLS + grants (P1-1):** `ENABLE ROW LEVEL SECURITY`; 4 per-user
    policies (`user_id = auth.uid()`); `GRANT SELECT,INSERT,UPDATE,DELETE TO authenticated, service_role`.
    (`check:migration-grants` only WARNs on missing RLS — verify by hand.)
  - **Backfill (P0-4):** include an explicit **column → (notification_type, channel) mapping** in the
    migration; backfill via per-column `INSERT … SELECT` (never a cross-join — it would invent `news×sms`
    rows). Add a verification query asserting inserted-row-count == count of pre-existing flags.
  - **Content-richness facet:** news/rumors/citations/top-movers are a separate `(type,channel,facet)`
    dimension (or retained columns) — NOT channel-enablement rows.
  - **Keep all 22 `*_include_*` columns**; Phase 0 is **additive** + dual-write. No DROP in Phase 0.
  - Telegram identity/state on `users`: `telegram_id` (bigint, unique, nullable), `telegram_chat_id`,
    `telegram_opted_out` (+ a DB CHECK mirroring `users_sms_opted_out_blocks_sms_enabled`, P2-4),
    `telegram_linked_at`.
  - `telegram_link_tokens` (or nonce store): `nonce PK, user_id, expires_at, consumed_at`; RLS on;
    service_role grant.
  - `telegram_updates` dedupe table (P1-3): `update_id bigint PK, received_at`; RLS on; service_role
    grant; `INSERT … ON CONFLICT DO NOTHING` returns seen-flag; TTL purge reusing the `purge_old_*` cron.
- Bump `app_metadata.schema_version` + `EXPECTED_DB_SCHEMA_VERSION` (`tests/helpers/constants.ts:5`);
  `npm run db:gen-types` (regenerates the `delivery_method` union — run **before** any
  `recordNotification(delivery_method:'telegram')`); pass `check:migration-grants` + `check:db-privileges`.

### 4.4 Widen channel unions (P1-2)
- Grep every `"email" | "sms"` literal union and widen to a `DeliveryMethod` derived from the generated
  enum — **load-bearing**: `schedule-state.ts:160` filters `scheduled_notifications` to email/sms and
  would silently drop telegram rows (breaking retry/next-send). Also `delivery-terminal.ts:14`,
  `daily-digest/delivery.ts`, `delivery-retry.ts:35`, `process.ts:607`. Add a check that no
  `scheduled_notifications` consumer drops unknown channels.

### 4.5 Deep-link linking token (P0-6)
- `src/lib/auth/deep-link-token.ts`: payload = single base64url blob of `{userId, expiresAtMs, nonce}`,
  HMAC-signed (`node:crypto createHmac` + `timingSafeEqual`); reuse the `unsubscribe.ts:44-78` approach
  but **not** its dotted `${ms}.${sig}` format (`.` is illegal in `/start`). Assert emitted token matches
  `^[A-Za-z0-9_-]{1,64}$`; **resolve the 64-char fit before finalizing the shape** (blocker, not spike).
- `/start` binds `from.id` → the **user_id from the token** (never from `from.id`). Single-use =
  **atomic conditional consume** (`UPDATE … WHERE nonce=$1 AND consumed_at IS NULL RETURNING`; zero rows
  → reject). **No fail-open** if the nonce row is missing.

### 4.6 Webhook endpoint (P0-7) + setWebhook (P0-11)
- `src/pages/api/messaging/telegram.ts`: `requireEnv('TELEGRAM_WEBHOOK_SECRET')` at top → **500 + process
  nothing** if unset; grammY `webhookCallback({ secretToken })` (verify constant-time, else gate the
  header with `timingSafeEqual`). `update_id` dedupe before handling. Return 2XX even on user-error (so
  Telegram doesn't retry) while logging.
- Add `/api/messaging/telegram` (exact, no trailing slash) to `WEBHOOK_PATHS` (`src/middleware.ts`) — an
  explicit task, not an aside.
- `npm run telegram:set-webhook`: idempotent (`getWebhookInfo`, compare URL+secret, `setWebhook` only on
  drift). URL = **apex** `https://stocktextalerts.com/api/messaging/telegram`. Run by a human after Vercel
  env + token are live; rotation re-runs it; preview/local use polling or a separate dev bot; document
  `deleteWebhook` teardown.

  **Shipped (`scripts/telegram/set-webhook.ts`).** Run with the bot token, `TELEGRAM_WEBHOOK_SECRET`, and
  either `TELEGRAM_WEBHOOK_URL` (preferred) or `SITE_URL` (derives `<SITE_URL>/api/messaging/telegram`) in
  the env:

  ```bash
  npm run telegram:set-webhook              # set only if the registered URL drifts
  npm run telegram:set-webhook -- --force   # always re-send (use for secret rotation —
                                            # Telegram never returns the secret, so drift
                                            # on the secret alone is undetectable)
  npm run telegram:set-webhook -- --delete  # tear the webhook down (dev / teardown)
  ```

### 4.7 Eligibility predicates
- `shouldSendTelegram()` / `isTelegramChannelUsable()` mirroring the SMS gates, reading the normalized
  table. Re-point existing `shouldSendSms` tests at the table.

### 4.8 Release sequencing (P0-10)
- The shared sender lib lives in `src/lib` (all functions import it), but `deploy-web.sh` code-deploys
  only 5 of 7. Either add the 2 missing functions to the `deploy_code` list **or** require a full
  `npm run deploy:aws` for the migration-introducing release. Stated order: **merge to main →
  `npm run deploy:aws` (admin) → enable the code path reading the new env var.** Add Vercel env
  separately. Make enum-add + code release atomic. Post-deploy: re-run `npm run audit:db-parity` (P1-13)
  and confirm zero residual drift for `notification_preferences` (RLS/policies/ACLs) and `delivery_method`.

## 5. Phase 1 — Canonical artifact + Telegram outbound (market-scheduled, end-to-end)

- **Phase-1 type = market-scheduled (P0-2)** — claim-RPC-backed, so `p_channel='telegram'` gives
  idempotency for free and exercises the harder canonical path. (Real-time price/flat alerts come later;
  they have no claim row.)
- Define `CanonicalAlertArtifact` (`src/lib/messaging/canonical/types.ts`) from the dossier's
  proto-canonical fields + the intraday **OHLC** series.
- **Intraday OHLCV parser:** add `extractIntradayOHLCV` (mirror `extractOHLCVFromBars`, `massive.ts:560`)
  so the `/range/5/minute/` fetch keeps `o/h/l/c/t`; thread through `enrichment.ts`. Minor
  `live-provider-check` note (the intraday fetch now reads more fields).
- Telegram renderer (`src/lib/messaging/telegram/render.ts`): `fmt` entities, neutral-wire copy,
  candlestick PNG via `buildCandlestickSvg` → `renderChartPng` (resvg), inline keyboard.
- Outbound sender (`src/lib/messaging/telegram/sender.ts`): grammY `Bot` + `auto-retry`, bounded
  concurrency (~3), `!isProduction()` hard-mock branch. grammY owns 429; **exclude telegram from
  `withDeliveryRetry`'s 429 path**; cap delay (worst case: ~500 sends × ~1/chat ÷ 3 concurrency ≈ 167s of
  a 300s tick — record the math in §10). `recordNotification(delivery_method:'telegram')`.
- **Chart caching (P2-2/2-3):** Lambda is fresh per minute-tick, so an in-process per-symbol cache mostly
  doesn't survive — prefer **Telegram `file_id` reuse** (resend by id) persisted in a small TTL table
  keyed `(symbol, session-window)`; reconcile with §10's no-message-tracking by scoping this to chart
  assets only. Memory sizing (P2-2): bump rendering function `MemorySize` for resvg.
- **`[Why?]` button (P1-7):** `generatePriceAlertSummary` runs once in `enrichAlert` and is gone by tap
  time. v1 decision: **inline the already-generated summary into the message body; drop the `[Why?]`
  button** (avoids on-demand Grok cost + persistence). On-demand `[Why?]` is a later seed (persist
  grokResult keyed to the callback nonce + rate/cost gate).
- Wire into the market-scheduled dispatch site behind `shouldSendTelegram()`. Verify by sending to your
  own linked account (no `live-provider-check` involvement; add a read-only `getMe`/`getWebhookInfo`
  health check for /ship's live step, P2-5).

## 6. Phase 2 — Roll across all types + retrofit SMS/email as down-renders

**Status (2026-06-19):** the **price-move (anomaly) single-asset alert** now delivers via Telegram with a
candlestick chart (`market-notifications/delivery.ts` `deliverPriceAlert`, threading a Telegram sender the
same way as the SMS sender; consumes the `telegram/chart.ts` candlestick module via
`telegram/price-alert.ts`). It piggybacks on the alert-level cooldown dedup — no separate Telegram ledger
needed for this type. **Still to do (same pattern, documented follow-up):** **flat-price** alerts
(`flat-alerts/delivery.ts`) and **price-target** alerts. Both need the same `formatPriceAlertTelegram`-style
renderer + a telegram branch threaded into their delivery; flat-price is real-time and should reuse its
existing idempotency key for a Telegram sent-message ledger if exactly-once matters.

- Build the canonical artifact for daily digest, asset events, price-target, flat-price, price-move (the
  remaining dossier §1 sites). For real-time types with no claim row, add a Telegram sent-message ledger
  keyed on the idempotency key flat-alerts already compute.
- **Channel-by-channel** refactor of `formatSmsMessage`/`formatEmailMessage` onto the canonical artifact;
  delete bespoke input bags as each migrates (no dual-convention window).
- **No-regression test gate (P0-12):** for each channel migration the **existing** formatter test files
  must pass **unchanged except for input construction** — output-byte assertions stay identical:
  `sms-format.test.ts`, `sms/segment-utils.test.ts`, `sms/block-packing.test.ts`,
  `sms/url-shortener.test.ts`, `email-format.test.ts`, `email/html-section.test.ts`, `sparkline.test.ts`,
  `svg-sparkline.test.ts`, plus dispatch tests. **Editing an existing output assertion in the same commit
  that refactors its formatter is forbidden.** `formatPriceAlertSms` is async (shortener) → keep the
  `.from().select().eq().gt().limit().single()` mock chain in its tests.
- **Migrate the `.or()` read sites (P0-5):** PostgREST `.or()` filter strings on `users` cannot reference
  another table. Enumerate and redesign each (`scheduled/select.ts:40`, `query.ts:46`,
  `asset-events/query.ts:46`, `unsubscribe.astro:38`, `current.ts:43`, `update.ts:26`, `seed-sql.ts:362`)
  as a join/EXISTS/view/RPC — each its own test-gated step. Then migrate writes. **DROP the 22 columns in
  a separate later migration** with its own `schema_version` bump.

## 7. Phase 3 — Two-way control plane

- Commands: `/start <token>` (link), `/quote <sym>`, `/watch`/`/unwatch`/`/list`, `/mute`, `/stop`
  (→ `telegram_opted_out`), `/unlink`, `/help`. Reuse the provider clients the crons use for `/quote`.
- **Auth reality (P0-8):** the bot has **no JWT** → it uses the `service_role` admin client → **RLS
  provides no backstop**. Identity = `resolveTelegramUser(from.id)` (shared helper all handlers route
  through); **every** mutation explicitly scopes `WHERE user_id = <resolved id>`. For mutating callbacks:
  re-derive the target object and assert ownership (don't trust ids in `callback_data`); bind a signed,
  short-TTL, single-use nonce into `callback_data` and consume atomically. `answerCallbackQuery` on every
  press. IDOR test: user A presses a button referencing user B's asset → rejected.
- Multi-step config via `conversations` on the **Supabase storage adapter**; obey the replay model
  (`conversation.external` around DB writes / API calls).

## 8. Phase 4 — Migration runway (no forced deprecation)

- Opt-in prompt: existing SMS/email carry a `t.me/<bot>?start=<token>` link.
- **Precedence (P1-11):** make "primary" an **explicit per-user/per-type field**; state default
  (linked-but-not-primary = both). Thread suppression through all ~8 dispatch sites
  (`market-notifications/delivery.ts:280`, `flat-alerts/delivery.ts:487`, `daily-digest/delivery.ts:594`,
  `scheduled/process.ts:281`). Test: linked + primary + both enabled → one `notification_log` row
  `delivery_method='telegram'`, zero SMS, email still sends.
- **Unlink/relink (P1-6):** `/unlink` + dashboard "Disconnect" null `telegram_id/chat_id/linked_at` and
  clear opt-out (the `telegram_id UNIQUE` constraint otherwise wedges users moving accounts); define
  already-linked / relink-to-new / expired-token cases.
- **Blocked-bot:** outbound 403 → set `telegram_opted_out`, stop sending, surface in ops. **Opt-out is
  set ONLY from a verified outbound 403, never from inbound content** (a forged webhook must not opt a
  victim out).
- **Adoption instrument (P2-13):** query/dashboard over `telegram_linked_at` + `notification_log`
  delivery_method counts; a concrete retirement threshold.
- Compliance: "not financial advice" disclaimer footer; geo-fallback keeps email/SMS where Telegram is
  unavailable (verify country list + Telegram bot ToS in Phase 4).

## 9. Phase 5 (later) — Native signup + live-edit

- Native signup: synthetic Supabase Auth user vs custom JWT; approval-gate interaction; account-merge
  when a link-only user later does native signup; Telegram Login Widget for dashboard.
- Live-edit "FLASH" thread: store `telegram_message_id` per (user, alert); edit idempotency (claim RPC is
  send-once); handle `"message is not modified"`. Spike the `editMessageText` rate limit first.

## 10. Locked decisions

1. **Scale < ~500 sends/tick** → in-process bounded-concurrency sender + `auto-retry`; no queue/SQS.
2. **Live-edit deferred to Phase 5.**
3. **Charts = candlesticks in v1** (spike resolved: OHLC already fetched; add intraday OHLCV parser),
   single-asset alerts only; multi-asset digests stay text-rich entity tables.
4. **`[Why?]` summary inlined in v1** (button + on-demand Grok deferred).
5. **Preferences normalized but additive in v1** (22 columns kept + dual-written; dropped post-Phase-2).

## 11. Dashboard UI (P1-8) — own phase, interleaved with Phase 1/3

- "Connect Telegram" card (mints deep-link, shows linked/disconnect state + unlinked empty state).
- Telegram column across `MarketNotificationsPanel`/`DailyNotificationsPanel`/`AssetEventsPanel`.
- Rewrite `/api/notification-preferences/update` onto the normalized table.

## 12. Testing (consolidated)

- **Sender mock-gate invariant (P1-9):** a test that non-production `createTelegramSender` never builds a
  network-capable Bot (mirrors `sender-gates.test.ts`, which exists post the 2026-04-11 real-delivery
  incident). The `!isProduction()` hard-gate is a stated invariant for **every** path constructing a Bot
  with the real token (sender, webhook reply, setWebhook script).
- **Webhook (P1-9):** `tests/api/messaging/telegram-inbound.test.ts` with a `buildTelegramUpdate`
  fixture; reject-on-bad/absent-secret asserts **no DB mutation**; `update_id` replay asserts DB state
  (not mock counts); middleware test that the path is in `WEBHOOK_PATHS`.
- **Test-user helper (P1-10):** extend `CreateTestUserOptions` with `telegramId/telegramChatId/
  telegramOptedOut` + `notification_preferences` row seeding; cleanup for the new tables (confirm cascade
  on user delete; the `telegram_updates` table is global → per-test `update_id`s or truncate in
  `afterEach`).
- **Conversations replay test:** drive a multi-step conversation across two simulated invocations; assert
  state survives and a DB write inside the conversation happens **exactly once** under forced replay.
- **Console-spy levels (P2-8):** blocked-bot 403 → info/warn (drives opt-out); exhausted/non-retryable →
  error. Blocked-bot test asserts the `telegram_opted_out` flag flips (behavioral).
- **Backups (P2-10):** new `telegram_*` columns enter backups (`backup/export.ts:80`) — update manifest
  `schema_version` test expectations; confirm `telegram_id/chat_id` acceptable in plaintext exports.

## 13. Observability & ops (P1-5)

- Log Telegram failures at `error` so they ride the existing `ErrorLogAlarm` MetricFilter
  (`template.yaml:694-771`); add a dedicated metric/alarm for sustained 429 (ban signal) and 403-block
  rate; mirror the vendor-retry-exhausted MetricFilter (`template.yaml:780`).
- Decide the **Vercel** webhook error surface (CloudWatch won't see it).
- `notification_log` retention (P2-11): decide v1 omission explicitly; telegram increases volume and has
  no place for telegram-only metadata (message_id, chart key) — note as omitted or add a purge fn.
- Error UX (P2-14): standard "not linked" reply, provider-timeout message (logged info/warn),
  expired-nonce reply, catch-all that still returns 2XX while logging.

## 14. Risks

- **Canonical refactor regression** (biggest) → channel-by-channel, byte-identical formatter tests, no
  dual-convention window.
- **resvg arm64 bundling** → `External` + layer + real-arm64 validation before Phase 1.
- **Ban from ignoring 429** → grammY `auto-retry` is non-optional; single retry owner.
- **Webhook double-processing / forged updates** → `update_id` dedupe + fail-closed secret.
- **Account-stream takeover** → token binds user_id as signed subject; atomic single-use; no fail-open.
- **IDOR via callbacks** → `resolveTelegramUser` + per-mutation ownership re-check + signed nonce.
- **Half-shipped release** → enum-add + code release atomic; full `deploy:aws` for env-var change.

## 15. References

- Code grounding dossier + adversarial review (this session's workflows).
- Verified research: grammy.dev/advanced/flood, /guide/deployment-types, /plugins/parse-mode,
  /plugins/conversations, /plugins/keyboard, /plugins/auto-retry; core.telegram.org/bots/faq, /bots/api;
  github.com/thx/resvg-js, github.com/grammyjs/storages.
- Key code anchors: `massive.ts:455,560`, `middleware.ts:186`, `dispatch-auth.ts:36`,
  `delivery-retry.ts:53`, `schedule-state.ts:160`, `svg-sparkline.test.ts`, `deploy-web.sh`.
