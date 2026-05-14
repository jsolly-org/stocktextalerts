# Extended-hours scheduled notifications

**Status:** Design (final, after three review passes)

**Date:** 2026-05-08

## Summary

Extend `market-scheduled` price notifications to fire during US pre-market (4:00 AM – 9:30 AM ET) and after-hours (4:00 PM – 8:00 PM ET) sessions, in addition to the existing regular session. Today the picker accepts only 10:00 AM – 3:59 PM ET; after this change it accepts **4:30 AM – 7:30 PM ET** (one continuous range, with 30-min outer buffers from absolute session boundaries). At delivery time, a Massive `/v1/marketstatus/now` call decides which session is active — if any, send with a session-aware label and change baseline; if none, log and skip.

This is a **single integrated change**: storage canonicalization, runtime session detection, snapshot-miss correctness fix, picker widening, session-aware rendering, removal of staging pre-render for market notifications. Ships as one commit per project workflow (no PRs).

## Motivation

The existing 10:00 AM – 3:59 PM ET clamp was a tight RTH-only product decision (commit `5fdba30a`, 2026-03-06). Relaxing it lets users follow names with overnight volatility (earnings releases, mega-cap tech, international news), gives non-ET users a wider envelope, and provides a post-close recap for users who can't watch markets during regular hours.

The change is anticipatory rather than driven by a concrete user request. The architecture preserves the option to tighten the picker bounds back if usage doesn't materialize — the runtime session detection and snapshot-miss correctness fix have value independent of the picker widening.

## Non-goals

- **Crypto / 24-7 assets.** Asset universe stays US stocks + ETFs from Massive.
- **International equities or non-US sessions.**
- **Daily digest.** `daily_digest_time` stays in user-local-minutes (asymmetric storage with `market_scheduled_asset_price_times`). Daily-digest is a personal-routine "morning summary" — even when it contains market data, the user picks 8 AM because they want it with their coffee, not because they want it 30 min before NYSE opens. Different semantic from "wake me at the moment of market open."
- **Anomaly / movement-alert behavior.** Their session-handling rules (the early-day-noise-reduction cap before 10 AM ET in `anomaly-detection.ts:235`) stay as-is. Anomaly detection has different concerns than scheduled "current price" reporting (the 30-min buffer in anomaly code suppresses false positives during volatile opens; a "current price" snapshot just reports what the price is — suppressing it would be patronizing).
- **Intraday extended-hours sparklines.** Scheduled notifications keep the existing 7-day daily-close sparkline (already session-agnostic).
- **Per-ticker session filtering.** US-listed equities all trade in the same session windows. A ticker with no session activity naturally produces 0% change against the appropriate baseline.

## On dropping the 10 AM ET buffer

The original clamp at 10:00 AM ET (30 min after regular open) was deliberate: avoid open-auction noise. This change drops that buffer (regular-session picks now allowed from 9:31 AM ET onward through the continuous 4:30 AM – 7:30 PM ET range). Rationale: a scheduled "current price" notification reports whatever the price is — it does not compare against a threshold like an anomaly alert does. The 30-min noise concern was about anomaly *detection*; for "tell me what AAPL is at 9:32 AM," the volatility is the actual story. The 30-min buffer in `anomaly-detection.ts:235` stays — different use case, different correctness needs.

## Architecture overview

```text
┌─ Schedule time (notification-preferences update) ────────┐
│  Form sends user-local-minutes; API converts to          │
│  ET-minutes via users.timezone before storing.           │
│  isOutsideMarketHours simplifies to a range check on     │
│  ET-minutes (no cross-midnight wrap to handle).          │
│  DB CHECK enforces 270 ≤ val ≤ 1170 — full integrity     │
│  layer compliance, no TZ math, no DST fudge.             │
└──────────────────────────────────────────────────────────┘

┌─ Picker UI (TimePicker.vue) ─────────────────────────────┐
│  Picker still operates in user-local-minutes for input.  │
│  Display converts stored ET-minutes → user-local for     │
│  showing chips. Helper text names inter-session gaps.    │
│  Disabled cells use aria-disabled + aria-label (fixes    │
│  existing WCAG 1.4.13 hover-only-tooltip gap).           │
└──────────────────────────────────────────────────────────┘

┌─ Cron tick (every 1 min, schedule.ts Lambda) ────────────┐
│  Per due user:                                           │
│    1. Existing closed-day rollforward + DST-drift safety │
│    2. NEW: getCurrentMarketSession() once at top of loop │
│    3. If "closed" → log info, bump next_send_at, skip    │
│    4. Otherwise → fetch quotes, render with session      │
│       label + appropriate change baseline, deliver.      │
│  No staging pre-render for market type — runs inline.    │
└──────────────────────────────────────────────────────────┘

┌─ price-fetcher.ts ───────────────────────────────────────┐
│  fillSnapshotMissesWithPrevDayBar accepts session as a   │
│  parameter (no internal API call). Caller passes the     │
│  session it already fetched.                             │
└──────────────────────────────────────────────────────────┘
```

## Storage canonicalization

`users.market_scheduled_asset_price_times` today stores `integer[]` of **minutes-since-midnight in the user's local timezone**. Different users with the same stored value `420` mean different absolute moments (7 AM ET vs 7 AM PT vs 7 AM JST), with `users.timezone` as the disambiguator.

This change migrates storage to **ET-minutes** (canonical). Stored value `600` means "10:00 AM ET" for everyone. The conversions live at the boundaries:

- **Picker / form input** (user-local-minute) → API write → store as ET-minute (using `users.timezone`).
- **Picker display** of stored values: ET-minute → user-local-minute (using `users.timezone`).
- **Cron** at send time: ET-minute → today's UTC instant (via Luxon's `America/New_York` zone, which handles DST correctly).
- **DB CHECK**: trivial — `val BETWEEN 270 AND 1170`.

### Behavior changes for users (documented, accepted)

For **US-TZ users** (the bulk of the user base), this is a no-op visually — Pacific Time, Central Time, etc. shift with Eastern Time across DST, so a user in `America/Los_Angeles` whose stored ET-minute is `600` (10 AM ET) sees their wall-clock notification arrive at 7 AM PT year-round. No drift.

For **non-US-TZ users** (Tokyo, London, etc.) whose timezones don't follow ET's DST schedule:

- **Seasonal drift**: wall-clock arrival time drifts ±1 hour seasonally. A Tokyo user whose stored ET-minute is `540` (9 AM ET) sees the notification arrive at 11 PM JST during EST (winter), 10 PM JST during EDT (summer).
- **Timezone change**: a user who picked "7 AM PT" (= 10 AM ET = stored as `600`) and then changes their profile timezone from Pacific to Eastern keeps the stored `600` — meaning notifications now fire at 10 AM ET local. This is a 3-hour shift on their wall clock from "7 AM" to "10 AM." This is the explicit semantic: scheduled times are anchored to ET, not to wall-clock-of-day. The timezone-settings UI will say so explicitly: *"Your scheduled times are anchored to US market hours. Changing your timezone updates display only, not when notifications fire."*

The spec accepts these trade-offs because the product is US-equity-only — market-anchored timing is more meaningful than wall-clock-anchored.

### Data migration

```sql
-- supabase/migrations/<timestamp>_migrate_market_times_to_et.sql
DO $$
DECLARE
  r RECORD;
  local_min INTEGER;
  et_minutes INTEGER;
  new_times INTEGER[];
  current_max_local INTEGER;
BEGIN
  -- Idempotency guard: if any row already has values in the post-migration
  -- ET range and outside the pre-migration local-minute range expected for
  -- that user's tz, the migration has already run. Bail.
  -- (Pre-migration values are clamped to 600-959 ET, which converts to a
  -- limited band of local-minutes per timezone. Detecting "this is already
  -- ET-anchored" cleanly is fragile — instead use a metadata sentinel.)
  IF EXISTS (
    SELECT 1 FROM public.app_metadata
    WHERE key = 'market_times_storage' AND value = 'et_minutes'
  ) THEN
    RAISE NOTICE 'market_times_storage is already et_minutes; skipping conversion';
    RETURN;
  END IF;

  FOR r IN
    SELECT id, timezone, market_scheduled_asset_price_times
    FROM public.users
    WHERE market_scheduled_asset_price_times IS NOT NULL
      AND array_length(market_scheduled_asset_price_times, 1) > 0
  LOOP
    new_times := '{}';
    FOREACH local_min IN ARRAY r.market_scheduled_asset_price_times
    LOOP
      et_minutes := EXTRACT(HOUR FROM (
        (CURRENT_DATE + (local_min * INTERVAL '1 minute'))
        AT TIME ZONE r.timezone
        AT TIME ZONE 'America/New_York'
      ))::INTEGER * 60
      + EXTRACT(MINUTE FROM (
        (CURRENT_DATE + (local_min * INTERVAL '1 minute'))
        AT TIME ZONE r.timezone
        AT TIME ZONE 'America/New_York'
      ))::INTEGER;

      -- Defensively clamp to the new valid range. Pre-migration values
      -- were validated against the 10:00–3:59 ET window in app code, so
      -- post-conversion values *should* fall in [600, 959]. But the
      -- conversion is approximate near DST edges; clamp into [270, 1170]
      -- so the new CHECK constraint cannot fail mid-deploy.
      IF et_minutes < 270 THEN et_minutes := 270; END IF;
      IF et_minutes > 1170 THEN et_minutes := 1170; END IF;

      IF NOT et_minutes = ANY(new_times) THEN
        new_times := array_append(new_times, et_minutes);
      END IF;
    END LOOP;

    SELECT COALESCE(array_agg(v ORDER BY v), '{}')
    INTO new_times FROM unnest(new_times) AS v;

    UPDATE public.users
    SET market_scheduled_asset_price_times = new_times
    WHERE id = r.id;
  END LOOP;

  -- Mark migration done so a re-run is a no-op.
  INSERT INTO public.app_metadata (key, value)
  VALUES ('market_times_storage', 'et_minutes')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
END $$;

-- Replace the CHECK constraint with the new range.
-- The actual constraint name is users_market_scheduled_asset_price_times_check
-- (the function backing it is is_valid_market_scheduled_asset_price_times,
-- but the constraint name itself is the table-prefixed default).
ALTER TABLE public.users
  DROP CONSTRAINT users_market_scheduled_asset_price_times_check;

ALTER TABLE public.users
  ADD CONSTRAINT users_market_scheduled_asset_price_times_check CHECK (
    market_scheduled_asset_price_times IS NULL
    OR (
      array_length(market_scheduled_asset_price_times, 1) <= 8
      AND (
        SELECT bool_and(val BETWEEN 270 AND 1170)
        FROM unnest(market_scheduled_asset_price_times) AS val
      )
    )
  );

UPDATE public.app_metadata
  SET value = '<this_migration_filename_without_extension>'
  WHERE key = 'schema_version';
```

**Implementation notes:**

- **Constraint name verified**: the actual constraint on `users.market_scheduled_asset_price_times` is `users_market_scheduled_asset_price_times_check` (per `supabase/migrations/20260212000000_consolidate_schema.sql:239`). The `is_valid_market_scheduled_asset_price_times` name is the *function* backing it. Get this right or the DROP will abort mid-migration with the data already converted.
- **Idempotency guard**: a sentinel in `app_metadata` (`market_times_storage = 'et_minutes'`) blocks re-running the conversion. Required because `db:reset` replays all migrations and naive re-conversion would treat already-ET values as local-minutes.
- **Defensive clamping**: pre-migration values were validated against 10:00–3:59 ET, so converted values *should* fall in [600, 959]. Edge cases near DST transitions (in user-local time) could produce values just outside that range. Clamping to [270, 1170] guarantees the new CHECK won't fail on `ALTER ADD CONSTRAINT`.
- **NULL handling**: the CHECK explicitly wraps with `IS NULL OR (...)` matching the existing pattern at `users_daily_digest_time_range` in `20260212000000_consolidate_schema.sql:247`.
- **Schema version**: replace the placeholder with the migration's actual filename (e.g., `20260508120000_migrate_market_times_to_et`) before commit. The project pattern is to use the filename without `.sql`.
- **`EXPECTED_DB_SCHEMA_VERSION`** in `tests/helpers/constants.ts` must update to match. Per `AGENTS.md`: "When adding migrations, update `app_metadata.schema_version` in SQL and `EXPECTED_DB_SCHEMA_VERSION` in `tests/helpers/constants.ts`." Tests abort at `tests/setup.ts:229` otherwise.

### Deploy timing

The migration uses `CURRENT_DATE` to anchor TZ conversion. For US-TZ users this is a no-op (their offset to ET is constant). For non-US-TZ users the converted ET-minute reflects the DST regime current at deploy time. **Deploy during EST (winter, between November and March)** so non-US-TZ users converge on EST-anchored ET-minutes; the documented seasonal drift is then "1 hour earlier in EDT summer" rather than the inverse, matching what the picker shows immediately post-deploy.

**Avoid the spring-forward gap (2:00–3:00 AM ET on the second Sunday of March)** — `CURRENT_DATE + (local_min * INTERVAL)` can produce ambiguous timestamps in that window for ET-resident users with stored times in 2:00–3:00 AM local.

## Runtime market session detection

### `parseMarketSession` (pure function)

```ts
export type MarketSession = "pre" | "regular" | "after" | "closed";

export function parseMarketSession(payload: unknown): MarketSession {
    if (typeof payload !== "object" || payload === null) {
        rootLogger.warn("Massive market-status payload is not an object", { payload });
        return "closed";
    }

    const record = payload as Record<string, unknown>;
    const market = typeof record.market === "string" ? record.market : null;

    if (market === null) {
        rootLogger.warn("Massive market-status payload missing 'market' field", { payload });
        return "closed";
    }

    // Authoritative: market === "open" means regular session, regardless of other flags.
    if (market === "open") return "regular";

    const earlyHours = record.earlyHours === true;
    const afterHours = record.afterHours === true;

    // Corrupt-payload guard: only fires when market !== "open" AND both flags set.
    if (earlyHours && afterHours) {
        rootLogger.warn("Massive market-status returned both earlyHours and afterHours true", { payload });
        return "closed";
    }

    if (earlyHours) return "pre";
    if (afterHours) return "after";
    return "closed";
}
```

**Pure function**, no I/O. Tests inject payloads directly. **Returns `"closed"` with `warn` log on bad payload** (rather than throwing). Rationale: a corrupt payload is indistinguishable from a transient API glitch — the next 60s cron tick recovers. Per `errors-and-logging.md`: `warn` is for "transient failures that the next retry / next scheduled invocation may recover from." Throwing would fire the `error`-level alert-hub alarm on every transient corruption. `marketDataFetch` already escalates to `error` on retry-exhaustion — that's the correct alarm-firing path.

### `getCurrentMarketSession` (I/O wrapper)

```ts
export async function getCurrentMarketSession(): Promise<MarketSession> {
    if (isTest() && !isLiveMassiveEnabledInTests()) {
        return "regular";
    }
    const data = await marketDataFetch("/v1/marketstatus/now", {}, "market-status");
    return parseMarketSession(data);
}
```

**No internal cache.** Fresh-process Lambda invocations make process-level caches a no-op in production. Session is fetched once at the top of the user-processing loop and passed as a parameter to anything downstream.

## Migrating `fetchMarketStatus`

Seven callers across six files (verified via grep):

- `src/lib/schedule/run.ts:212`
- `src/lib/market-notifications/process.ts:179`
- `src/lib/providers/price-fetcher.ts:94` (the snapshot-miss guard)
- `src/lib/daily-digest/process.ts:442`
- `src/lib/price-targets/process.ts:70`
- `src/lib/staged-notifications/precompute.ts:114, :213`

```ts
// before:
const isMarketOpen = await fetchMarketStatus();
if (isMarketOpen) { /* RTH path */ }

// after:
const session = await getCurrentMarketSession();
if (session === "regular") { /* RTH path */ }
```

**`fetchMarketStatus` deleted entirely.** Per `code-style.md`: "No shims, adapters, deprecation wrappers... Delete the old shape when you change a shape."

**Daily-digest plumbing also touches**: `precomputeDailyDigest:213` plumbs `marketOpen` into `dispatchDailyDigestUser` (in `src/lib/daily-digest/dispatch.ts`). The boolean → `=== "regular"` conversion happens at the call site; `dispatchDailyDigestUser` continues to accept `marketOpen: boolean`. No signature change to `dispatchDailyDigestUser` — the conversion is a one-liner at each callsite.

## `calculateNextSendAtFromTimes` signature change

`src/lib/time/scheduled-times.ts:42-90` (`calculateNextSendAt` and `calculateNextSendAtFromTimes`) currently take `(localMinutes, timezone, now)`. After this change they take `(etMinutes, now)` — the timezone parameter goes away because storage is ET-canonical.

**Five call sites** (verified via grep — three were missed in earlier spec drafts):

1. `src/lib/time/scheduled-times.ts:177` (`computeNextSendAtIso`) — used by `notification-preferences-update.ts:69, :305`
2. `src/lib/time/market-scheduled-next-send.ts:28` — the closed-day rollforward loop
3. `src/lib/time/format.ts:192` — `getSecondsUntilNextSend` (Vue countdown display)
4. (via `computeNextSendAtIso`) `src/lib/api/notification-preferences-update.ts:69` — `next_send_at` calculation on save
5. (via `computeNextSendAtIso`) `src/lib/api/notification-preferences-update.ts:305` — `computeTimezoneUpdatePayload`

All five drop the `timezone` parameter. Cron's `next_send_at` math is now "ET-minute → today's UTC instant" via `DateTime.fromObject({...}, { zone: 'America/New_York' })`. Existing DST-fall-back logic (`pickLaterOffset`) stays — it now applies only to ET's DST transitions (twice a year), not arbitrary user TZs.

**`computeTimezoneUpdatePayload` correction**: today this function calls `computeNextSendAtIso(stored_local_minutes, newTimezone, ...)` to recompute `next_send_at` after a timezone change. After this change, stored values are ET-minutes — invariant under timezone changes. The `next_send_at` recomputation simplifies (no per-tz conversion), and the call site drops the `newTimezone` argument.

## `isOutsideMarketHours` signature change

`src/lib/time/format.ts:254` currently takes `(timeMinutes, userTimezone)` and does cross-midnight wrap math via `getMarketNotificationLocalRange`. After this change, the function operates on ET-minutes directly:

```ts
export function isOutsideMarketHours(etMinutes: number): boolean {
    if (!Number.isInteger(etMinutes) || etMinutes < 0 || etMinutes > 1439) {
        return true;
    }
    return etMinutes < US_MARKET_EARLIEST_NOTIFICATION_EASTERN_MINUTES
        || etMinutes > US_MARKET_LATEST_NOTIFICATION_EASTERN_MINUTES;
}
```

Cross-midnight wrap logic and `getMarketNotificationLocalRange` go away. ET-minutes don't wrap (the [270, 1170] window is fully inside one day in ET).

**This breaks 9 existing tests in `tests/lib/time/market-hours.test.ts`** that pass a `timezone` argument. All of them need their call signature updated to drop the second argument. Specific lines to update: 9, 14, 19, 24, 29, 33, 38, 44, 45, 55, 59 — verify against current file before editing.

## Snapshot-miss fix (`fillSnapshotMissesWithPrevDayBar`)

```ts
// New signature:
async function fillSnapshotMissesWithPrevDayBar(
    symbols: string[],
    snapshot: Map<string, unknown>,
    session: MarketSession,
): Promise<void> {
    const missing = symbols.filter((symbol) => snapshot.get(symbol) === null);
    if (missing.length === 0) return;
    if (session !== "closed") return; // any active session: leave miss as null
    // Fall back to prev-day bar only when fully closed
    for (const symbol of missing) { /* unchanged */ }
}
```

Caller passes the session it already fetched at the top of its user loop. **This is a real correctness fix**: today, snapshot misses during pre-market (when `fetchMarketStatus()` returns false because `market !== "open"`) fall back to yesterday's daily bar labeled as "current price" — exactly the misleading behavior the existing comment block warns against, just in a session the original author hadn't anticipated. After this change, misses during pre/after-hours leave the row as null (downstream renders as `—` or drops), matching the existing RTH semantic.

## Picker / UI changes

### Picker (`src/components/dashboard/shared/TimePicker.vue`)

The existing `minTimeOverride` / `maxTimeOverride` plumbing already supports a same-day window via vue-datepicker's `min-time` and `max-time` props. Same-day works directly because ET-minutes don't wrap.

**Changes:**

1. New helpers `etMinuteToUserLocal(etMin: number, tz: string): number` and `userLocalToEtMinute(localMin: number, tz: string): number` in `src/lib/time/format.ts`. The picker reads stored ET-minutes, displays as user-local; submit converts back.
2. Min/max bounds for the picker come from `etMinuteToUserLocal(270, tz)` and `etMinuteToUserLocal(1170, tz)`. For non-US TZs the displayed range may cross midnight — vue-datepicker can't enforce cross-midnight ranges, so the existing "window crosses midnight" hint stays.
3. **A11y fix**: replace hover-only `title` attribute on disabled cells with `aria-disabled="true"` + `aria-label` describing why disabled. This fixes existing WCAG SC 1.4.13 (Content on Hover) violation.

### Schedule controls (`ScheduledUpdateControls.vue`, `MarketNotificationsPanel.vue`)

Replace hardcoded "10:00 AM – 3:59 PM ET" strings with the new range. Updated copy:

> **Choose up to {{ maxTimes }} time slots.** Notifications send anytime US markets are trading (pre-market, regular, or after-hours). Pick any time between 4:30 AM and 7:30 PM ET. Sends are skipped if markets aren't trading at your scheduled time — this includes early-close days (~3 per year), full-day holidays, and the 30-minute gaps between sessions (9:00–9:30 AM and 4:00–4:30 PM ET).

Cross-midnight hint span gets `aria-describedby` linking it to the time-picker input so screen readers announce the constraint on focus.

**No session badge per slot.** Helper text + delivered-message session label are sufficient.

### Timezone-settings UI

Add a brief disclosure in the timezone-settings section (`src/components/profile/TimezoneSection.vue`):

> *"Your scheduled times are anchored to US market hours. Changing your timezone updates display only, not when notifications fire."*

This addresses the timezone-change semantic gap: a user moving from PT to ET keeps the same ET-anchored notifications; the disclosure prevents surprise.

## Message rendering

### Header / banner

Today's email subject line stays `"Your Scheduled Price Notification"` (preserves mailbox threading). The **first body line** of email and the **first line of SMS** include a session label:

| Session | First line |
| --- | --- |
| `pre` | `Pre-market — 7:00 AM ET` |
| `regular` | `Regular hours — 12:00 PM ET` |
| `after` | `After-hours — 5:00 PM ET` |

The header carries only the session label and time — no close-anchor parenthetical. The HTML markup is `<p>` with `font-weight: bold` and explicit color tokens meeting WCAG SC 1.4.3 (4.5:1 contrast).

### Change baseline

All sessions use yesterday's close (Massive `todaysChangePerc` / `prevDay.c`) — the convention used by Robinhood, Yahoo Finance, and Apple Stocks. This means the after-hours headline change-% reads "where are we today total" rather than "what moved post-close." It also keeps the intraday-since-open sparkline anchor aligned with the headline.

| Session | Baseline | Source field |
| --- | --- | --- |
| `pre` | yesterday's close | `todaysChangePerc` |
| `regular` | yesterday's close | `todaysChangePerc` |
| `after` | yesterday's close | `todaysChangePerc` |

Earlier drafts of this spec called for an after-hours-only anchor (today's 4 PM close) and a `†` fallback footnote when today's regular close was unavailable. That approach was reverted on 2026-05-14: it created a contradiction between the (post-close-only) headline and the (since-open) sparkline, and casual traders' mental model of "today" matches the prev-close convention rather than the regular-close convention. See commit history for `src/lib/messaging/asset-formatting.ts` for the removed `computeSessionChangePercent` machinery.

### No staleness annotation, no row dropping

Massive's snapshot returns the latest trade — that *is* the current price. A 5-hour-old print on a thinly-traded name in pre-market is still the current price. Change-% against the right baseline communicates whatever's happening.

### Behavioral change in `asset-formatting.ts`

`marketOpen: boolean` plumbing replaces with `marketSession: MarketSession`. **This is a behavioral change, not just a type swap**: today's logic suppresses the change-% line when `marketOpen === false` (commit `ce75b950`). The new gate is `if (marketSession !== "closed") emit change%; else suppress` — meaning **pre-market and after-hours notifications now emit change-%** with the appropriate baseline. The test plan includes an explicit scenario asserting change-% is emitted (not suppressed) in pre/after renders.

## Removing staging for market type

Today's `precomputeMarketScheduled` (in `src/lib/staged-notifications/precompute.ts:111`) pre-renders email/SMS bodies into `staged_notifications.staged_data` for "near-instant delivery." With session resolution moving to delivery time, the pre-rendered content can't be session-correct (the staging-vs-delivery 30s gap can straddle a session boundary, causing wrong change baselines at 4:00 PM ET transitions specifically).

**Decision**: delete `precomputeMarketScheduled` and the market-type code path. Cron runs inline at the user's `next_send_at`. `precomputeDailyDigest` stays — daily digests are RTH-only with no session-boundary issue.

### Latency cost (disclosed)

Today: market notification delivery is just SES/Twilio at the scheduled minute (rendering happened ~30s prior).
After this change: cron tick at scheduled minute does session check (~50-200ms) + quote fetch (~100-500ms for ~10 tickers) + sparkline fetch (~1-3s for batched) + render + send.

**Users with large watchlists may see delivery shifted by 5-15 seconds past the scheduled minute** (e.g., 7:00:08 instead of 7:00:00). The helper text addition discloses this:

> *"Notifications send within ~10 seconds of your scheduled time."*

### Type changes

- `src/lib/staged-notifications/types.ts:18` (`StagedMarketData`) and the `StagedData` union: remove the market entry. Existing rows can age out via the `STALE_MAX_AGE_MINUTES` purge.
- `src/lib/staged-notifications/deliver.ts`: remove market-type handling.
- `src/lib/staged-notifications/precompute.ts`: delete `precomputeMarketScheduled`.

## Constants update

```ts
// src/lib/constants.ts
// Before: 10:00 AM – 3:59 PM ET (US_MARKET_EARLIEST_NOTIFICATION_EASTERN_MINUTES = 600, ..._LATEST = 959)
// After:  4:30 AM – 7:30 PM ET
export const US_MARKET_EARLIEST_NOTIFICATION_EASTERN_MINUTES = 4 * 60 + 30; // 4:30 AM ET, minute 270
export const US_MARKET_LATEST_NOTIFICATION_EASTERN_MINUTES = 19 * 60 + 30; // 7:30 PM ET, minute 1170
```

Update both comments to reflect the new values and rationale.

## Send / skip flow

`src/lib/market-notifications/scheduled/process.ts`:

```ts
// At top of per-user loop:
const session = await getCurrentMarketSession();

if (session === "closed") {
    logger.info("Skipping scheduled market delivery — no active session", {
        userId: user.id,
        scheduledEtMinutes,
        dueAt: dueAt.toISO(),
    });
    stats.skipped++;
    await updateUserMarketScheduledNextSendAt({ user, supabase, logger, currentTime });
    return stats;
}

// session is "pre" | "regular" | "after"
// Plumb to renderers — replace marketOpen: boolean with marketSession: MarketSession.
```

**Silent skip behavior**: when runtime says "no session active," the cron logs at `info` and bumps `next_send_at`. No "markets are closed today" notification is sent. Rationale: the helper text discloses this upfront, so the behavior is expected. If usage shows users are confused, follow-up: write a `skipped_at` row to a small new table the dashboard renders.

The existing `marketClosure` short-circuit at update-time (which pre-computes `next_send_at` to skip known-in-advance closed days via Massive's `/v1/marketstatus/upcoming`) stays — it prevents unnecessary cron wakeups on weekends/holidays.

## Logging

| Event | Level | Context |
| --- | --- | --- |
| Skipping send because no session active at delivery | `info` | `userId`, `scheduledEtMinutes`, `dueAt`, `session: "closed"` |
| `parseMarketSession` rejects payload (bad shape, both flags set, missing `market`) | `warn` | full payload |
| `day.close` missing or zero in after-hours — fallback used | `info` | `userId`, `symbol`, `session: "after"` |
| Massive `marketDataFetch` retry-exhaustion | `error` (existing behavior in `marketDataFetch`) | unchanged |
| Successful staging / send | existing levels | (unchanged) |

**Massive outage behavior**: during a sustained outage, every cron tick exhausts retries and logs `error` (~1 alarm-firing event per minute). `aws/template.yaml:432-435` sets `Period: 60, EvaluationPeriods: 1, Threshold: 1` — alarm transitions to ALARM on first error log line. SNS routes one notification on transition (current alert-hub behavior); subsequent error log lines stay in CloudWatch but don't re-trigger emails until alarm transitions back to OK. So one notification email per outage, then quiet — acceptable.

## Testing plan

### New: `tests/lib/providers/parse-market-session.test.ts`

Pure-function tests, scenario-event framing:

- "A regular-hours payload from Massive is classified as a regular session"
- "A pre-market payload from Massive is classified as pre-market"
- "An after-hours payload from Massive is classified as after-hours"
- "A fully-closed payload from Massive is classified as closed"
- "A corrupt payload with both early/after flags set is safely downgraded to closed and logged at warn" (uses `expectConsoleWarning()`)
- "A payload missing the `market` field is safely downgraded to closed and logged at warn"
- "A non-object payload is safely downgraded to closed and logged at warn"
- "When the market is open, set early/after flags do not override regular-session classification"

### Updated: `tests/lib/time/market-hours.test.ts`

- **Delete** existing assertion that 9:30 AM ET is invalid (now valid).
- **Update signature** for all 9 `isOutsideMarketHours` callers — drop the `timezone` argument since the function now operates on ET-minutes (lines 9, 14, 19, 24, 29, 33, 38, 44, 45, 55, 59 — verify against current file).
- **Replace** the existing Tokyo cross-midnight test with a round-trip helper test: `userLocalToEtMinute(1380, "Asia/Tokyo")` → `540` (winter EST) or `480` (summer EDT); `etMinuteToUserLocal(540, "Asia/Tokyo")` → `1380` (winter) or `1440` (summer). Document the seasonal drift in the test description.
- **Add** new boundary cases: 270 valid; 269 invalid; 1170 valid; 1171 invalid.

### New / updated: storage migration tests

- **`tests/api/notification-preferences/update-notification-preferences.test.ts`** — assert that submitting `420` minutes with `timezone: America/Los_Angeles` (= 7 AM PT) writes `600` minutes to the DB (= 10 AM ET, in winter). Assert that round-trip read displays as `420` again via `etMinuteToUserLocal`.
- **New `tests/lib/db/market-times-migration.test.ts`** — set up users with various pre-migration local-minute values + timezones, run the migration SQL, assert post-migration ET-minute values are correct (including DST edge cases for non-US TZs and the defensive clamp).

### Updated mocks (all `fetchMarketStatus` mocks → `getCurrentMarketSession`)

- `tests/lib/schedule/daily-digest-closure-fanout.test.ts` — mock target updates; line `:68` (mocks `precomputeMarketScheduled`) needs its market-type scenario removed since the function no longer exists
- `tests/lib/price-targets/process.test.ts` — mock target update; add scenario tests for `pre` and `after` session classification
- `tests/lib/staged-notifications/precompute.test.ts` — mock target update at lines 5, 9, 24, 26 (full hoisted-mock declaration block, not just the references at 8 and 46)
- `tests/lib/live-provider-apis.test.ts:72` — split into two tests:
  - "getCurrentMarketSession returns a valid MarketSession value from live Massive"
  - "Massive `/v1/marketstatus/now` payload includes earlyHours and afterHours boolean fields" (asserts via `marketDataFetch` directly)

### Updated: `tests/lib/staged-notifications/deliver.test.ts`

Imports and constructs `StagedMarketData` (currently used at lines 22, 82, 148, 225). After this change the type is gone; market-type scenarios in this file must be deleted entirely. Daily-digest scenarios stay.

### Updated: `tests/lib/schedule/run.test.ts`

Lines 59-68 construct a `StagedMarketData` fixture directly — delete those scenarios (no longer applicable; cron runs inline for market). Add new scenarios:

- "A user with a 7:00 AM ET pre-market scheduled time receives a message labeled `Pre-market` with change-% computed vs. yesterday's close"
- "A user with a 5:00 PM ET after-hours scheduled time receives a message labeled `After-hours` with change-% computed vs. today's regular close, plus the close-anchor reference"
- "A pre-market scheduled message renders with a non-empty change-% column for every ticker — verifying the suppression gate flip in asset-formatting.ts"
- "A user with multiple time slots spanning all three sessions on the same day cycles `next_send_at` correctly"
- "A scheduled time on a half-day in the after-hours dead zone is skipped at delivery (runtime session = `closed`), logged at `info`, `next_send_at` advances"
- "A 9:31 AM ET regular-session send produces a regular-hours message — verifies the buffer drop"
- "When `getCurrentMarketSession` returns `closed` for one user, the cron continues processing other users in the batch" (no abort on per-user skip)
- `it.skip("On a half-day after 1:00 PM ET, if Massive returns 'after', behavior is TBD pending live verification")` — see Open Question #2 below

### Updated: `tests/helpers/constants.ts`

Bump `EXPECTED_DB_SCHEMA_VERSION` to match the new `app_metadata.schema_version` set by the migration.

## Affected files (comprehensive)

**Modified:**

- `src/lib/constants.ts` — widen `US_MARKET_EARLIEST_NOTIFICATION_EASTERN_MINUTES` (600 → 270), `US_MARKET_LATEST_NOTIFICATION_EASTERN_MINUTES` (959 → 1170)
- `src/lib/providers/price-fetcher.ts` — add `parseMarketSession`, `getCurrentMarketSession`; delete `fetchMarketStatus`; update `fillSnapshotMissesWithPrevDayBar` to take session parameter
- `src/lib/time/format.ts` — `isOutsideMarketHours` operates on ET-minutes (drops `timezone` param); add `etMinuteToUserLocal`, `userLocalToEtMinute` helpers; remove `getMarketNotificationLocalRange` (cross-midnight wrap no longer needed)
- `src/lib/time/scheduled-times.ts` — `calculateNextSendAt` and `calculateNextSendAtFromTimes` switch from `(localMinutes, timezone, now)` to `(etMinutes, now)`; `computeNextSendAtIso` updates accordingly
- `src/lib/time/market-scheduled-next-send.ts` — caller of `calculateNextSendAtFromTimes` updates to drop `timezone` arg
- `src/lib/api/notification-preferences-update.ts` — convert local-minutes from form to ET-minutes before storing; `computeTimezoneUpdatePayload` simplifies (stored ET-minutes are tz-invariant); remove `newTimezone` arg from `computeNextSendAtIso` call
- `src/lib/schedule/run.ts:212` — migrate `fetchMarketStatus` callsite
- `src/lib/market-notifications/process.ts:179` — migrate `fetchMarketStatus` callsite
- `src/lib/daily-digest/process.ts:442` — migrate `fetchMarketStatus` callsite
- `src/lib/daily-digest/dispatch.ts` — accepts `marketOpen: boolean` from caller (no signature change; conversion happens at call site)
- `src/lib/price-targets/process.ts:70` — migrate `fetchMarketStatus` callsite
- `src/lib/staged-notifications/precompute.ts` — delete `precomputeMarketScheduled`; migrate `fetchMarketStatus` callsite at `:213` (daily digest path)
- `src/lib/staged-notifications/deliver.ts` — remove market-type handling; daily-digest stays
- `src/lib/staged-notifications/types.ts` — remove `StagedMarketData` from `StagedData` union
- `src/lib/market-notifications/scheduled/process.ts` — fetch session at top of user loop, replace `marketOpen: boolean` plumbing with `marketSession: MarketSession`; remove `stageOnly` market path
- `src/lib/market-notifications/scheduled/delivery.ts` — accept `marketSession`, render session-aware first line
- `src/lib/messaging/asset-formatting.ts` — **behavioral change: change-% suppression gate flips for pre/after sessions; add after-hours `day.close` baseline + close-anchor reference; handle `day.close === 0`-or-missing fallback to `prevClose` with `†` annotation**
- `src/lib/messaging/email/delivery.ts`, `src/lib/messaging/sms/delivery.ts` — render session-aware first line
- `src/components/dashboard/shared/TimePicker.vue` — replace hover-only `title` with `aria-disabled` + `aria-label` on disabled cells (a11y fix); use new `etMinuteToUserLocal` helper for displayed bounds
- `src/components/dashboard/market-notifications/ScheduledUpdateControls.vue`, `MarketNotificationsPanel.vue` — copy updates; `aria-describedby` on cross-midnight hint; reads stored ET-minutes via display helper
- `src/components/profile/TimezoneSection.vue` — add disclosure that scheduled times are ET-anchored

**Added:**

- `supabase/migrations/<timestamp>_migrate_market_times_to_et.sql` (data migration + CHECK update)
- `tests/lib/providers/parse-market-session.test.ts`
- `tests/lib/db/market-times-migration.test.ts`

**Removed:**

- `fetchMarketStatus` (function)
- `getMarketNotificationLocalRange` (helper, no longer needed)
- `precomputeMarketScheduled` (function)
- Market-type entries in `StagedData` union and `staged-notifications/deliver.ts` handlers

**Test files updated:**

- `tests/lib/time/market-hours.test.ts` — signature change for 9 callsites + test additions/deletions
- `tests/lib/schedule/run.test.ts` — delete StagedMarketData fixtures; add new session-aware scenarios
- `tests/lib/schedule/daily-digest-closure-fanout.test.ts` — mock migration; remove `precomputeMarketScheduled` mock
- `tests/lib/price-targets/process.test.ts` — mock migration; add session-classification scenarios
- `tests/lib/staged-notifications/precompute.test.ts` — mock migration (full block at lines 5-26)
- `tests/lib/staged-notifications/deliver.test.ts` — delete market-type scenarios (lines 22, 82, 148, 225)
- `tests/lib/live-provider-apis.test.ts:72` — split into two tests
- `tests/api/notification-preferences/update-notification-preferences.test.ts` — assert ET-minute storage round-trip
- `tests/helpers/constants.ts` — bump `EXPECTED_DB_SCHEMA_VERSION`

**Unchanged:**

- `aws/template.yaml` — `schedule.ts` Lambda already runs `rate(1 minute)` always-on
- Daily-digest staging path (`precomputeDailyDigest`) — RTH-only, no session-boundary issue

## Open implementation questions

1. **Massive payload field names.** This spec assumes `earlyHours` / `afterHours` boolean fields. Implementation must verify against live data first (`npm run test:live:data`) and adjust `parseMarketSession` if Massive uses different signaling. The split live test (asserting field-shape via `marketDataFetch`) catches future regressions; initial verification is manual before code is written.

2. **Half-day after-hours behavior.** On half-days (regular ends 1:00 PM ET, no after-hours), Massive *should* return `closed` from 1:00 PM ET onward. Verify before relying on this. If Massive returns `after` during 1:00–4:00 PM on half-days, the runtime check would fire a notification with `day.close` baseline — possibly wrong. **Tracked in tests** as `it.skip("On a half-day after 1:00 PM ET, if Massive returns 'after', behavior is TBD pending live verification")` with a `// TODO(half-day-verification): resolve before final commit, by 2026-05-15` comment.

3. **DST safety at deploy time.** Migration uses `CURRENT_DATE`. Deploy during EST (between November and the second Sunday of March). Avoid the spring-forward gap (2:00–3:00 AM ET on the second Sunday of March) for ET-resident users with stored times in 2:00–3:00 AM local.
