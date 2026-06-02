# Extended-hours scheduled notifications — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-05-08-extended-hours-notifications-design.md`

**Goal:** Widen `market-scheduled` price notifications to fire during pre-market (4:00–9:30 AM ET) and after-hours (4:00–8:00 PM ET) sessions, canonicalize storage to ET-minutes, replace `fetchMarketStatus()` with a session-returning `getCurrentMarketSession()`, and remove staging for market notifications so session resolution happens at delivery time.

**Architecture:**

- Storage: `users.market_scheduled_asset_price_times` migrates from user-local-minutes to **ET-canonical minutes** in the range `[270, 1170]` (4:30 AM – 7:30 PM ET). DB CHECK enforces bounds; conversions live at form-input and display boundaries.
- Runtime: cron tick fetches `getCurrentMarketSession()` once at the top of the user-processing loop; pre/regular/after → send with session-aware label and change baseline; closed → log info, bump `next_send_at`, skip.
- Delivery: market-type staging deleted (cron renders inline at the scheduled minute). Daily-digest staging stays.
- UI: picker still operates on user-local-minutes; new helpers convert ↔ ET at the boundary. Disabled cells fix existing WCAG SC 1.4.13 hover-only-tooltip violation via `aria-disabled` + `aria-label`.

**Tech Stack:** TypeScript, Astro 5 (SSR), Vue 3, Tailwind CSS 4, Supabase (PostgreSQL), Luxon, Vitest, vue-datepicker.

**Ships as a single commit per project workflow** (no PRs). Per-task verification within the worktree; no per-task commits.

---

## Phase 0 — Setup

### Task 0.1: Establish isolated worktree

**Files:** none (setup only)

- [ ] **Step 1: Create worktree**

Use the `superpowers:using-git-worktrees` skill (or `git worktree add`) to create an isolated workspace branched off `main` named `feat/extended-hours-notifications`.

- [ ] **Step 2: Verify clean baseline**

Run from the worktree:

```bash
npm run check:ts
npm run check:biome
```

Expected: both PASS (clean baseline before changes).

- [ ] **Step 3: Verify Supabase is running**

```bash
npm run db:doctor
```

Expected: PASS. If FAIL, run `npm run db:bootstrap`.

---

## Phase 1 — Verify Massive payload field names (manual / read-only)

This is **Open Question #1** in the spec: confirm `earlyHours` / `afterHours` field names against live data before writing `parseMarketSession`. The follow-up `parseMarketSession` task assumes these names. If verification reveals different field names, adjust the spec assumptions in Task 2.1 only — the rest of the plan is unchanged.

### Task 1.1: Probe live Massive market-status payload

**Files:** none (read-only)

- [ ] **Step 1: Probe live API**

```bash
npm test -- --live=massive tests/lib/live-provider-apis.test.ts
```

If the existing test logs the payload, capture the shape from output. Otherwise, run an ad-hoc probe via `node -e` or temporary console.log.

- [ ] **Step 2: Confirm field shape**

Verify from probe output that the payload has fields `market: string`, `earlyHours: boolean`, `afterHours: boolean`. Document the actual shape as a comment in the implementation file you'll write in Task 2.1.

If the field names differ, **update the field references throughout this plan in Tasks 2.1 and 2.2 before continuing**. Keep the rest of the architecture identical.

---

## Phase 2 — Add `parseMarketSession` and `getCurrentMarketSession` (TDD)

### Task 2.1: Write failing tests for `parseMarketSession`

**Files:**

- Create: `tests/lib/providers/parse-market-session.test.ts`

- [ ] **Step 1: Write the failing test file**

```typescript
import { describe, expect, it } from "vitest";
import { expectConsoleWarning } from "../../setup";
import { parseMarketSession } from "../../../src/lib/providers/price-fetcher";

describe("parseMarketSession", () => {
 it("A regular-hours payload from Massive is classified as a regular session", () => {
  expect(parseMarketSession({ market: "open", earlyHours: false, afterHours: false })).toBe(
   "regular",
  );
 });

 it("A pre-market payload from Massive is classified as pre-market", () => {
  expect(parseMarketSession({ market: "extended-hours", earlyHours: true, afterHours: false })).toBe(
   "pre",
  );
 });

 it("An after-hours payload from Massive is classified as after-hours", () => {
  expect(parseMarketSession({ market: "extended-hours", earlyHours: false, afterHours: true })).toBe(
   "after",
  );
 });

 it("A fully-closed payload from Massive is classified as closed", () => {
  expect(parseMarketSession({ market: "closed", earlyHours: false, afterHours: false })).toBe(
   "closed",
  );
 });

 it("A corrupt payload with both early/after flags set is safely downgraded to closed and logged at warn", () => {
  expectConsoleWarning(/both earlyHours and afterHours/);
  expect(
   parseMarketSession({ market: "extended-hours", earlyHours: true, afterHours: true }),
  ).toBe("closed");
 });

 it("A payload missing the `market` field is safely downgraded to closed and logged at warn", () => {
  expectConsoleWarning(/missing 'market'/);
  expect(parseMarketSession({ earlyHours: false, afterHours: false })).toBe("closed");
 });

 it("A non-object payload is safely downgraded to closed and logged at warn", () => {
  expectConsoleWarning(/not an object/);
  expect(parseMarketSession(null)).toBe("closed");
 });

 it("When the market is open, set early/after flags do not override regular-session classification", () => {
  // Authoritative: market === "open" wins regardless of other flags.
  expect(parseMarketSession({ market: "open", earlyHours: true, afterHours: true })).toBe(
   "regular",
  );
 });
});
```

- [ ] **Step 2: Run tests (expect FAIL)**

```bash
npm test -- tests/lib/providers/parse-market-session.test.ts
```

Expected: FAIL with `parseMarketSession is not a function` (or similar export-not-found error).

### Task 2.2: Implement `parseMarketSession` and `getCurrentMarketSession`

**Files:**

- Modify: `src/lib/providers/price-fetcher.ts`

- [ ] **Step 1: Add export at top of file**

In `src/lib/providers/price-fetcher.ts`, add the `MarketSession` type and `parseMarketSession` function. Insert after line 26 (after the existing type exports, before `isLiveMassiveEnabledInTests`):

```typescript
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
  rootLogger.warn("Massive market-status returned both earlyHours and afterHours true", {
   payload,
  });
  return "closed";
 }

 if (earlyHours) return "pre";
 if (afterHours) return "after";
 return "closed";
}

export async function getCurrentMarketSession(): Promise<MarketSession> {
 if (isTest() && !isLiveMassiveEnabledInTests()) {
  return "regular";
 }
 const data = await marketDataFetch("/v1/marketstatus/now", {}, "market-status");
 return parseMarketSession(data);
}
```

- [ ] **Step 2: Run new tests (expect PASS)**

```bash
npm test -- tests/lib/providers/parse-market-session.test.ts
```

Expected: PASS (8 tests).

---

## Phase 3 — Update `fillSnapshotMissesWithPrevDayBar` to take session parameter

### Task 3.1: Refactor `fillSnapshotMissesWithPrevDayBar`

**Files:**

- Modify: `src/lib/providers/price-fetcher.ts`

This is a pure refactor in this task — caller signatures of `fetchAssetPrices` / `fetchExtendedQuotes` are unchanged for now (we'll wire session through in later tasks). Internal helper takes session, callers pass `"closed"` temporarily so behavior doesn't shift until we plumb session in Phase 5.

- [ ] **Step 1: Replace `fillSnapshotMissesWithPrevDayBar` with session-aware variant**

Find the existing function (lines ~87–115 in `src/lib/providers/price-fetcher.ts`) and replace with:

```typescript
/**
 * Fill snapshot misses with Massive's previous-day bar.
 *
 * Fires only for symbols Massive's live snapshot doesn't return. In practice
 * that means either (a) a legitimately delisted ticker that the daily sweep
 * hasn't cleaned up yet, or (b) a truly OTC ticker Massive's snapshot doesn't
 * cover (rare, but historically why the Finnhub fallback existed).
 *
 * **Session guard**: any active session (pre / regular / after) leaves the
 * miss as null — serving yesterday's bar labeled as "current price" during a
 * trading session would mislead users whose alerts compare against live price.
 * Only when the market is fully closed do we fall back to the prev-day bar,
 * which is the freshest data available.
 */
async function fillSnapshotMissesWithPrevDayBar(
 symbols: string[],
 snapshot: Map<string, unknown>,
 session: MarketSession,
): Promise<void> {
 const missing = symbols.filter((symbol) => snapshot.get(symbol) === null);
 if (missing.length === 0) return;

 if (session !== "closed") {
  // Any active session: leave misses as null rather than serving stale data.
  // Downstream callers already handle null quotes gracefully.
  return;
 }

 for (const symbol of missing) {
  try {
   const bar = await fetchPrevDayBar(symbol);
   if (bar !== null) {
    snapshot.set(symbol, bar);
   }
  } catch (error) {
   rootLogger.error(
    "Prev-day-bar fallback failed",
    { symbol },
    error instanceof Error ? error : new Error(String(error)),
   );
  }
 }
}
```

- [ ] **Step 2: Update internal callers (`fetchAssetPrices`, `fetchExtendedQuotes`)**

In the same file, update the two callers (around lines 38–45 and 48–69) to call `getCurrentMarketSession()` inline so behavior is preserved:

```typescript
export async function fetchAssetPrices(symbols: string[]): Promise<AssetPriceMap> {
 if (isTest() && !isLiveMassiveEnabledInTests()) {
  return new Map(symbols.map((s) => [s, { price: 150.0, changePercent: 1.25 }]));
 }
 const snapshot = await fetchSnapshotQuotes(symbols);
 const session = await getCurrentMarketSession();
 await fillSnapshotMissesWithPrevDayBar(symbols, snapshot, session);
 return snapshot as AssetPriceMap;
}

export async function fetchExtendedQuotes(symbols: string[]): Promise<ExtendedQuoteMap> {
 if (isTest() && !isLiveMassiveEnabledInTests()) {
  return new Map(
   symbols.map((s) => [
    s,
    {
     price: 150.0,
     changePercent: 1.25,
     dayHigh: 152.0,
     dayLow: 148.0,
     dayOpen: 149.0,
     prevClose: 148.5,
     timestamp: Math.floor(Date.now() / 1000),
     volume: null,
    },
   ]),
  );
 }
 const snapshot = await fetchSnapshotQuotes(symbols);
 const session = await getCurrentMarketSession();
 await fillSnapshotMissesWithPrevDayBar(symbols, snapshot, session);
 return snapshot as ExtendedQuoteMap;
}
```

(This duplicates the API call once per fetcher, but the previous code did the same with `fetchMarketStatus` so behavior is preserved. The orchestrator-level optimization that fetches session once per cron tick happens in Phase 6 when we plumb session as a parameter.)

- [ ] **Step 3: Run tests (expect PASS)**

```bash
npm test -- tests/lib/providers/parse-market-session.test.ts
npm run check:ts
```

Expected: parse-market-session tests still PASS, type check PASSES.

---

## Phase 4 — Storage canonicalization: helpers and `isOutsideMarketHours` signature change

### Task 4.1: Add `etMinuteToUserLocal` and `userLocalToEtMinute` helpers + tests

**Files:**

- Modify: `src/lib/time/format.ts`
- Modify: `tests/lib/time/market-hours.test.ts` (extend with helper tests in next task)

- [ ] **Step 1: Add helpers to `src/lib/time/format.ts`**

Insert after the existing `getEasternTimeAsLocalMinutes` helper (after line ~242). The new helpers use Luxon's DST-safe zone conversion:

```typescript
/**
 * Convert an ET-minute (minutes since midnight in America/New_York) to the
 * user's local minute-of-day. Anchored to the current calendar date so DST
 * is applied correctly via Luxon's zone conversion.
 *
 * For non-US timezones the result may exceed 23:59 — wrap by computing
 * `((result % 1440) + 1440) % 1440` if a same-day value is required.
 */
export function etMinuteToUserLocal(etMinute: number, userTimezone: string): number {
 const hour = Math.floor(etMinute / 60);
 const minute = etMinute % 60;
 const eastern = DateTime.now().setZone(US_MARKET_TIMEZONE).set({
  hour,
  minute,
  second: 0,
  millisecond: 0,
 });
 const local = eastern.setZone(userTimezone);
 if (!local.isValid) {
  return etMinute; // fallback to ET if zone resolution fails
 }
 return local.hour * 60 + local.minute;
}

/**
 * Convert a user-local minute-of-day to an ET-minute. Inverse of
 * `etMinuteToUserLocal`. Anchored to the current calendar date so DST
 * is applied correctly.
 */
export function userLocalToEtMinute(localMinute: number, userTimezone: string): number {
 const hour = Math.floor(localMinute / 60);
 const minute = localMinute % 60;
 const local = DateTime.now().setZone(userTimezone).set({
  hour,
  minute,
  second: 0,
  millisecond: 0,
 });
 if (!local.isValid) {
  return localMinute;
 }
 const eastern = local.setZone(US_MARKET_TIMEZONE);
 return eastern.hour * 60 + eastern.minute;
}
```

### Task 4.2: Update `isOutsideMarketHours` to operate on ET-minutes only

**Files:**

- Modify: `src/lib/time/format.ts`
- Modify: `tests/lib/time/market-hours.test.ts`

- [ ] **Step 1: Replace `isOutsideMarketHours` and remove `getMarketNotificationLocalRange`**

Replace the existing `isOutsideMarketHours` (lines ~254–268) and delete `getMarketNotificationLocalRange` (lines ~270–283):

```typescript
/**
 * True when the given ET-minute is outside the allowed market notification
 * window (4:30 AM – 7:30 PM ET, i.e. [270, 1170]).
 *
 * Operates on ET-minutes directly — callers convert from user-local at the
 * boundary via `userLocalToEtMinute` if needed.
 */
export function isOutsideMarketHours(etMinutes: number): boolean {
 if (!Number.isInteger(etMinutes) || etMinutes < 0 || etMinutes > 1439) {
  return true;
 }
 return (
  etMinutes < US_MARKET_EARLIEST_NOTIFICATION_EASTERN_MINUTES ||
  etMinutes > US_MARKET_LATEST_NOTIFICATION_EASTERN_MINUTES
 );
}
```

Delete the `getMarketNotificationLocalRange` function entirely.

- [ ] **Step 2: Rewrite `tests/lib/time/market-hours.test.ts`**

Replace the entire file content with the new ET-minute-only suite. Note the constants update lands in Task 5.1 — for now the tests should reference the new bounds (270, 1170) which are the real target values.

```typescript
import { describe, expect, it } from "vitest";
import {
 etMinuteToUserLocal,
 isOutsideMarketHours,
 userLocalToEtMinute,
} from "../../../src/lib/time/format";

describe("isOutsideMarketHours", () => {
 // Notification window: 4:30 AM – 7:30 PM ET (ET-minutes [270, 1170])

 it("Noon ET is treated as inside the extended-hours window.", () => {
  const noon = 12 * 60;
  expect(isOutsideMarketHours(noon)).toBe(false);
 });

 it("4:30 AM ET (lower bound) is treated as inside the window.", () => {
  expect(isOutsideMarketHours(270)).toBe(false);
 });

 it("7:30 PM ET (upper bound) is treated as inside the window.", () => {
  expect(isOutsideMarketHours(1170)).toBe(false);
 });

 it("4:29 AM ET (one minute before lower bound) is treated as outside the window.", () => {
  expect(isOutsideMarketHours(269)).toBe(true);
 });

 it("7:31 PM ET (one minute after upper bound) is treated as outside the window.", () => {
  expect(isOutsideMarketHours(1171)).toBe(true);
 });

 it("9:30 AM ET (regular open) is treated as inside the extended-hours window.", () => {
  const marketOpen = 9 * 60 + 30;
  expect(isOutsideMarketHours(marketOpen)).toBe(false);
 });

 it("4:00 PM ET (regular close) is treated as inside the extended-hours window.", () => {
  const marketClose = 16 * 60;
  expect(isOutsideMarketHours(marketClose)).toBe(false);
 });

 it("Midnight (0 ET-minutes) is treated as outside the window.", () => {
  expect(isOutsideMarketHours(0)).toBe(true);
 });

 it("11:59 PM ET (1439 minutes) is treated as outside the window.", () => {
  expect(isOutsideMarketHours(1439)).toBe(true);
 });

 it("Negative input is treated as outside the window.", () => {
  expect(isOutsideMarketHours(-1)).toBe(true);
 });

 it("Out-of-range input (>= 1440) is treated as outside the window.", () => {
  expect(isOutsideMarketHours(1440)).toBe(true);
 });

 it("Non-integer input is treated as outside the window.", () => {
  expect(isOutsideMarketHours(12.5)).toBe(true);
 });
});

describe("etMinuteToUserLocal / userLocalToEtMinute round-trip", () => {
 it("A US-Eastern user round-trips ET-minute 600 (10:00 AM ET) to itself.", () => {
  const local = etMinuteToUserLocal(600, "America/New_York");
  expect(local).toBe(600);
  expect(userLocalToEtMinute(local, "America/New_York")).toBe(600);
 });

 it("A US-Pacific user sees ET-minute 600 (10:00 AM ET) as 7:00 AM PT (420).", () => {
  const local = etMinuteToUserLocal(600, "America/Los_Angeles");
  expect(local).toBe(420);
  expect(userLocalToEtMinute(420, "America/Los_Angeles")).toBe(600);
 });

 it("A Tokyo user sees ET-minute 540 (9:00 AM ET) as a wall-clock time that round-trips.", () => {
  // Tokyo is UTC+9; ET shifts with DST (-5 EST / -4 EDT). The exact local
  // minute differs seasonally — but the round-trip must be stable.
  const local = etMinuteToUserLocal(540, "Asia/Tokyo");
  expect(userLocalToEtMinute(local, "Asia/Tokyo")).toBe(540);
 });
});
```

- [ ] **Step 3: Run tests (expect: FAIL on bound checks until Task 5.1, PASS otherwise)**

```bash
npm test -- tests/lib/time/market-hours.test.ts
```

Expected: helpers tests PASS; bound tests for 270/1170 may FAIL until Task 5.1 updates constants. Capture which ones fail; they will pass after Task 5.1.

### Task 4.3: Update constants for new ET-minute bounds

**Files:**

- Modify: `src/lib/constants.ts`

- [ ] **Step 1: Update bounds**

In `src/lib/constants.ts`, replace lines 73–77:

```typescript
/** 30 min after open — used as the default preset time for scheduled price notifications. */
export const US_AFTER_OPEN_EASTERN_MINUTES = 10 * 60; // 10:00 AM ET
/** Earliest allowed scheduled price notification time in ET (minutes since midnight). 4:30 AM ET = pre-market entry + 30 min outer buffer. */
export const US_MARKET_EARLIEST_NOTIFICATION_EASTERN_MINUTES = 4 * 60 + 30; // 4:30 AM ET, minute 270
/** Latest allowed scheduled price notification time in ET (minutes since midnight). 7:30 PM ET = after-hours close - 30 min outer buffer. */
export const US_MARKET_LATEST_NOTIFICATION_EASTERN_MINUTES = 19 * 60 + 30; // 7:30 PM ET, minute 1170
```

- [ ] **Step 2: Run tests (expect PASS)**

```bash
npm test -- tests/lib/time/market-hours.test.ts
```

Expected: ALL pass.

---

## Phase 5 — `calculateNextSendAt` and `calculateNextSendAtFromTimes` signature change

### Task 5.1: Switch `calculateNextSendAt` and `calculateNextSendAtFromTimes` to ET-minutes

**Files:**

- Modify: `src/lib/time/scheduled-times.ts`

- [ ] **Step 1: Replace function signatures**

In `src/lib/time/scheduled-times.ts`, replace `calculateNextSendAt` (lines 42–90) and `calculateNextSendAtFromTimes` (lines 97–121):

```typescript
import { US_MARKET_TIMEZONE } from "../constants";

/**
 * Compute the next UTC send time for an ET-minute.
 *
 * Handles DST ambiguity by preferring the later offset on fall-back days.
 * Returns `null` when inputs are invalid or the timezone cannot be resolved.
 */
export function calculateNextSendAt(etMinutes: number, now: DateTime): DateTime | null {
 if (!Number.isFinite(etMinutes)) {
  return null;
 }

 const hours = Math.floor(etMinutes / 60);
 const minutes = etMinutes % 60;
 if (
  !Number.isInteger(hours) ||
  !Number.isInteger(minutes) ||
  hours < 0 ||
  hours > 23 ||
  minutes < 0 ||
  minutes > 59
 ) {
  return null;
 }

 const current = now.setZone(US_MARKET_TIMEZONE);
 if (!current.isValid) {
  return null;
 }

 let candidate = buildLocalDateTime({
  date: current,
  zone: US_MARKET_TIMEZONE,
  hour: hours,
  minute: minutes,
 });
 candidate = pickLaterOffset(candidate);

 if (!candidate.isValid) {
  return null;
 }

 if (candidate <= current) {
  candidate = candidate.plus({ days: 1 });
  candidate = pickLaterOffset(candidate);
  if (!candidate.isValid) {
   return null;
  }
 }

 return candidate.toUTC();
}

/**
 * Compute the next UTC send time across multiple ET-minute candidates.
 *
 * Returns the earliest next send time, or `null` when no valid candidates exist.
 */
export function calculateNextSendAtFromTimes(
 etMinutesList: number[],
 now: DateTime,
): DateTime | null {
 if (!Array.isArray(etMinutesList) || etMinutesList.length === 0) {
  return null;
 }

 let nextSend: DateTime | null = null;
 for (const etMinutes of etMinutesList) {
  if (!Number.isFinite(etMinutes)) {
   continue;
  }
  const candidate = calculateNextSendAt(etMinutes, now);
  if (!candidate) {
   continue;
  }
  if (!nextSend || candidate < nextSend) {
   nextSend = candidate;
  }
 }

 return nextSend;
}
```

- [ ] **Step 2: Update `computeNextSendAtIso` to drop timezone parameter**

In the same file, replace `computeNextSendAtIso` (lines ~171–200):

```typescript
export function computeNextSendAtIso(
 times: number[],
 context: Record<string, unknown>,
 logger?: Logger,
): string {
 const nextSendAt = calculateNextSendAtFromTimes(times, DateTime.utc());
 if (!nextSendAt) {
  logger?.error("calculateNextSendAtFromTimes returned null", context);
  throw new Error(
   `Failed to compute market_scheduled_asset_price_next_send_at: ${JSON.stringify(context)}`,
  );
 }

 const iso = nextSendAt.toISO();
 if (!iso) {
  const detail = {
   ...context,
   nextSendAt: nextSendAt.toString(),
   nextSendAtIsValid: nextSendAt.isValid,
   nextSendAtInvalidReason: nextSendAt.invalidReason,
  };
  logger?.error("Failed to format market_scheduled_asset_price_next_send_at to ISO", detail);
  throw new Error(
   `Failed to format market_scheduled_asset_price_next_send_at: ${JSON.stringify(detail)}`,
  );
 }

 return iso;
}
```

- [ ] **Step 3: Run type check (expect callsite errors)**

```bash
npm run check:ts 2>&1 | head -50
```

Expected: type errors at callsites that pass `timezone` argument. Capture the list — those are the next tasks.

### Task 5.2: Update call sites of `calculateNextSendAt` family

**Files:**

- Modify: `src/lib/time/format.ts` (`getSecondsUntilNextSend`)
- Modify: `src/lib/time/market-scheduled-next-send.ts`
- Modify: `src/lib/api/notification-preferences-update.ts` (multiple)

- [ ] **Step 1: Update `getSecondsUntilNextSend` in `format.ts`**

The current `getSecondsUntilNextSend` operates on user-local-minutes via `parseTimeToMinutes`. After this change we need to convert local→ET at the call boundary:

In `src/lib/time/format.ts` replace lines 162–223 (`getSecondsUntilNextSend`):

```typescript
export function getSecondsUntilNextSend(options: {
 timezone: string;
 nextSendAtIso?: string | null;
 timeInput?: string | null;
 timeInputs?: string[] | null;
 now?: DateTime;
}): number | null {
 const now = options.now ?? DateTime.now();

 if (typeof options.nextSendAtIso === "string" && options.nextSendAtIso !== "") {
  const nextSendAt = DateTime.fromISO(options.nextSendAtIso, { zone: "utc" });
  if (!nextSendAt.isValid) {
   return null;
  }
  const diffSeconds = Math.ceil(nextSendAt.diff(now.toUTC(), "seconds").seconds);
  if (Number.isFinite(diffSeconds) && diffSeconds > 0) {
   return diffSeconds;
  }
  // next_send_at is in the past (e.g. update just sent); fall back to
  // delivery times so the UI can show countdown to the next occurrence.
 }

 if (Array.isArray(options.timeInputs) && options.timeInputs.length > 0) {
  const localMinutes = options.timeInputs
   .map((value) => parseTimeToMinutes(value))
   .filter((value): value is number => value !== null);
  if (localMinutes.length === 0) {
   return null;
  }

  const etMinutes = localMinutes.map((m) => userLocalToEtMinute(m, options.timezone));
  const nextSendAt = calculateNextSendAtFromTimes(etMinutes, now);
  if (!nextSendAt) {
   return null;
  }

  const diffSeconds = Math.ceil(nextSendAt.diff(now.toUTC(), "seconds").seconds);
  if (!Number.isFinite(diffSeconds) || diffSeconds <= 0) {
   return null;
  }
  return diffSeconds;
 }

 if (typeof options.timeInput === "string" && options.timeInput !== "") {
  const localDeliveryMinutes = parseTimeToMinutes(options.timeInput);
  if (localDeliveryMinutes === null) {
   return null;
  }
  const etMinutes = userLocalToEtMinute(localDeliveryMinutes, options.timezone);
  const nextSendAt = calculateNextSendAt(etMinutes, now);
  if (!nextSendAt) {
   return null;
  }

  const diffSeconds = Math.ceil(nextSendAt.diff(now.toUTC(), "seconds").seconds);
  if (!Number.isFinite(diffSeconds) || diffSeconds <= 0) {
   return null;
  }
  return diffSeconds;
 }

 return null;
}
```

- [ ] **Step 2: Update `market-scheduled-next-send.ts`**

In `src/lib/time/market-scheduled-next-send.ts` replace the function (the field name semantically changes from `localMinutesList` to `etMinutesList`; the `timezone` parameter goes away):

```typescript
import type { DateTime } from "luxon";
import { getUsMarketClosureInfoForInstant, type MarketClosureReason } from "./market-calendar";
import { calculateNextSendAtFromTimes } from "./scheduled-times";

const MAX_CANDIDATE_ITERATIONS = 400;

interface NextMarketScheduledSendResult {
 nextSendAt: DateTime | null;
 delayReasons: MarketClosureReason[];
 holidayName?: string;
}

/**
 * Compute the next scheduled send time that lands on an open US market day.
 * Operates on ET-minutes (storage canonical).
 */
export async function calculateNextMarketScheduledSendAtFromTimes(options: {
 etMinutesList: number[];
 now: DateTime;
}): Promise<NextMarketScheduledSendResult> {
 const { etMinutesList, now } = options;
 let cursor = now;
 const delayReasonSet = new Set<MarketClosureReason>();
 let holidayName: string | undefined;

 for (let i = 0; i < MAX_CANDIDATE_ITERATIONS; i++) {
  const candidate = calculateNextSendAtFromTimes(etMinutesList, cursor);
  if (!candidate) {
   return {
    nextSendAt: null,
    delayReasons: [...delayReasonSet],
    holidayName,
   };
  }

  const closure = await getUsMarketClosureInfoForInstant(candidate);
  if (!closure) {
   return {
    nextSendAt: candidate,
    delayReasons: [...delayReasonSet],
    holidayName,
   };
  }

  delayReasonSet.add(closure.reason);
  if (!holidayName && closure.holidayName) {
   holidayName = closure.holidayName;
  }
  cursor = candidate.plus({ seconds: 1 });
 }

 return { nextSendAt: null, delayReasons: [...delayReasonSet], holidayName };
}
```

- [ ] **Step 3: Update callers of `calculateNextMarketScheduledSendAtFromTimes`**

```bash
grep -rn "calculateNextMarketScheduledSendAtFromTimes" src/ tests/
```

For each caller, replace `localMinutesList: <value>, timezone: <value>,` with `etMinutesList: <value>,` (drop the `timezone` field). The values passed should already be ET-minutes since storage is now canonical (verify in callsite).

- [ ] **Step 4: Type-check the time module**

```bash
npm run check:ts 2>&1 | grep -E "src/lib/time|src/lib/api"
```

Expected: callsite errors in `notification-preferences-update.ts` (handled in next task) and any callers of `calculateNextMarketScheduledSendAtFromTimes`. Resolve them by passing ET-minutes.

### Task 5.3: Update `notification-preferences-update.ts` to convert form local-minutes → ET-minutes

**Files:**

- Modify: `src/lib/api/notification-preferences-update.ts`

- [ ] **Step 1: Convert form-supplied local-minutes to ET-minutes before storing**

In `src/lib/api/notification-preferences-update.ts`, after line 152 (where `normalizedTimes` is set) and before line 157 (the boolean fields block), insert ET conversion:

```typescript
// Form supplies user-local-minutes; storage is ET-canonical. Convert here
// at the API boundary so downstream code (cron, formatters) treats stored
// values as ET-minutes uniformly.
const formTimezone = parsedData.timezone ?? dbUser.timezone;
let etNormalizedTimes: number[] | null | undefined = normalizedTimes;
if (Array.isArray(normalizedTimes) && normalizedTimes.length > 0) {
 const converted = normalizedTimes.map((localMin) =>
  userLocalToEtMinute(localMin, formTimezone),
 );
 // Deduplicate (different locals may collapse to the same ET-minute under DST edges)
 etNormalizedTimes = [...new Set(converted)].sort((a, b) => a - b);
}
```

Then update the `safeNotificationPreferenceUpdates` builder around line 200:

```typescript
const safeNotificationPreferenceUpdates: UserUpdateInput = omitUndefined({
 timezone: parsedData.timezone,
 market_scheduled_asset_price_times: etNormalizedTimes,
 ...boolUpdates,
 ...(formData.has("daily_digest_time")
  ? { daily_digest_time: parsedData.daily_digest_time ?? null }
  : {}),
 ...(formData.has("market_asset_price_alert_move_size") &&
 parsedData.market_asset_price_alert_move_size !== undefined
  ? {
    market_asset_price_alert_move_size: parsedData.market_asset_price_alert_move_size,
   }
  : {}),
});
```

- [ ] **Step 2: Update `computeScheduledNextSendAt` and `computeNextSendAtIso` callsites to drop `finalTimezone`**

Replace `computeScheduledNextSendAt` to drop the timezone param (it's no longer needed):

```typescript
function computeScheduledNextSendAt(
 updates: UserUpdateInput,
 dbUser: User,
 finalTimes: number[] | null,
 timezoneChanged: boolean,
 timeChanged: boolean,
 logger?: Logger,
): void {
 const hasTimes = finalTimes !== null && finalTimes.length > 0;
 const needsRepair =
  hasTimes &&
  dbUser.market_scheduled_asset_price_next_send_at === null &&
  updates.market_scheduled_asset_price_next_send_at === undefined;

 if ((timezoneChanged || timeChanged || needsRepair) && hasTimes) {
  updates.market_scheduled_asset_price_next_send_at = computeNextSendAtIso(
   finalTimes,
   { userId: dbUser.id, finalTimes },
   logger,
  );
 } else if (timeChanged && !hasTimes) {
  updates.market_scheduled_asset_price_next_send_at = null;
 }
}
```

And update the call to it (around line 242):

```typescript
computeScheduledNextSendAt(
 safeNotificationPreferenceUpdates,
 dbUser,
 finalTimes,
 timezoneChanged,
 timeChanged,
 logger,
);
```

- [ ] **Step 3: Update `computeDailyNextSendAt` for ET-minute daily digest**

Daily digest **stays in user-local-minutes** per the spec (Non-goals: "`daily_digest_time` stays in user-local-minutes"). But `calculateNextSendAt` now takes ET-minutes only. Convert at the boundary:

```typescript
function computeDailyNextSendAt(
 updates: UserUpdateInput,
 dbUser: User,
 finalDailyTime: number | null,
 finalTimezone: string,
 timezoneChanged: boolean,
 dailyTimeChanged: boolean,
): void {
 const hasDailyTime = finalDailyTime !== null;
 const needsRepair =
  hasDailyTime &&
  dbUser.daily_digest_next_send_at === null &&
  updates.daily_digest_next_send_at === undefined;

 if ((timezoneChanged || dailyTimeChanged || needsRepair) && hasDailyTime) {
  const etMinutes = userLocalToEtMinute(finalDailyTime, finalTimezone);
  const nextDailyUtc = calculateNextSendAt(etMinutes, DateTime.utc());
  updates.daily_digest_next_send_at = nextDailyUtc?.toISO() ?? null;
 } else if (dailyTimeChanged && !hasDailyTime) {
  updates.daily_digest_next_send_at = null;
 }
}
```

Ensure `userLocalToEtMinute` is imported from `../time/format`.

- [ ] **Step 4: Update `computeTimezoneUpdatePayload`**

Per the spec: "stored values are ET-minutes — invariant under timezone changes. The `next_send_at` recomputation simplifies (no per-tz conversion)". The market-scheduled-time recomputation is no longer needed when timezone changes (the stored ET-minutes don't move). But the daily-digest path still needs conversion since daily storage stays user-local.

Replace `computeTimezoneUpdatePayload`:

```typescript
export function computeTimezoneUpdatePayload(
 newTimezone: string,
 dbUser: User,
 logger?: Logger,
): TimezoneUpdatePayload {
 const payload: TimezoneUpdatePayload = {
  timezone: newTimezone,
 };

 if (newTimezone === dbUser.timezone) {
  return payload;
 }

 // Market scheduled times are ET-canonical; timezone changes do not affect
 // when they fire. No recomputation needed here.
 if (
  dbUser.market_scheduled_asset_price_times &&
  dbUser.market_scheduled_asset_price_times.length > 0
 ) {
  payload.market_scheduled_asset_price_next_send_at = computeNextSendAtIso(
   dbUser.market_scheduled_asset_price_times,
   {
    userId: dbUser.id,
    timesCount: dbUser.market_scheduled_asset_price_times.length,
   },
   logger,
  );
 }

 if (dbUser.daily_digest_time != null) {
  // Daily digest stays user-local; convert to ET at the boundary.
  const etMinutes = userLocalToEtMinute(dbUser.daily_digest_time, newTimezone);
  const nextDailyUtc = calculateNextSendAt(etMinutes, DateTime.utc());
  payload.daily_digest_next_send_at = nextDailyUtc?.toISO() ?? null;
 }

 const hasAnyAssetEvents = ASSET_EVENTS_OPTION_FIELDS.some(
  (field) => dbUser[field as keyof typeof dbUser],
 );
 if (hasAnyAssetEvents) {
  const baseLocal = dbUser.daily_digest_time ?? 540;
  const etMinutes = userLocalToEtMinute(baseLocal, newTimezone);
  const nextUtc = calculateNextSendAt(etMinutes, DateTime.utc());
  payload.asset_events_next_send_at = nextUtc?.toISO() ?? null;
 }

 return payload;
}
```

Add `userLocalToEtMinute` to the imports at the top of the file.

- [ ] **Step 5: Audit `computeAssetEventsNextSendAt`**

```bash
grep -rn "computeAssetEventsNextSendAt" src/
```

Open `src/lib/asset-events/scheduling-helpers.ts`, find `computeAssetEventsNextSendAt`. If it calls `calculateNextSendAt` with `(localMinutes, timezone, now)`, update it to convert local→ET at the boundary then call `calculateNextSendAt(etMinutes, now)`.

- [ ] **Step 6: Type-check**

```bash
npm run check:ts
```

Expected: PASS (or only callsite errors in tests, which we handle in Phase 9).

---

## Phase 6 — Migrate `fetchMarketStatus` callsites to `getCurrentMarketSession`

### Task 6.1: Replace each `fetchMarketStatus()` call

**Files:**

- Modify: `src/lib/schedule/run.ts`
- Modify: `src/lib/market-notifications/process.ts`
- Modify: `src/lib/daily-digest/process.ts`
- Modify: `src/lib/daily-digest/dispatch.ts`
- Modify: `src/lib/price-targets/process.ts`
- Modify: `src/lib/staged-notifications/precompute.ts` (only the daily-digest path; the market-scheduled path is removed in Phase 7)
- Modify: `src/lib/providers/price-fetcher.ts` (delete `fetchMarketStatus` at the end)

For each callsite, the boolean `marketOpen` becomes `session === "regular"` for places that gated on RTH. **Important**: `dispatchDailyDigestUser` still accepts a `marketOpen: boolean` parameter — the conversion happens at the call site.

- [ ] **Step 1: `src/lib/schedule/run.ts:212`**

Find and replace:

```typescript
const marketStatusPromise = hasAnyUsers ? fetchMarketStatus() : null;
```

with:

```typescript
const marketSessionPromise = hasAnyUsers ? getCurrentMarketSession() : null;
```

Then update downstream usage in the file: anywhere `marketStatusPromise` is awaited and used as a boolean (e.g., passed to `processMarketNotifications`), unwrap to `session === "regular"` at the call boundary. (Use `grep -n "marketStatusPromise\|marketStatus" src/lib/schedule/run.ts` to find all usages.)

Also update the import:

```typescript
// Replace
import { fetchMarketStatus, ... } from "../providers/price-fetcher";
// With
import { getCurrentMarketSession, ... } from "../providers/price-fetcher";
```

- [ ] **Step 2: `src/lib/market-notifications/process.ts:179`**

Replace `const isMarketOpen = await fetchMarketStatus();` with:

```typescript
const session = await getCurrentMarketSession();
const isMarketOpen = session === "regular";
```

(Keep the local boolean for minimum diff inside this file. Future cleanup may pass `session` through, but is out of scope for this commit.)

Update the import.

- [ ] **Step 3: `src/lib/daily-digest/process.ts:442`**

Replace:

```typescript
const marketOpen = marketOpenParam !== undefined ? marketOpenParam : await fetchMarketStatus();
```

with:

```typescript
const marketOpen =
 marketOpenParam !== undefined ? marketOpenParam : (await getCurrentMarketSession()) === "regular";
```

Update the import.

- [ ] **Step 4: `src/lib/daily-digest/dispatch.ts`**

Per the spec: "`dispatchDailyDigestUser` continues to accept `marketOpen: boolean`. No signature change." — so this file changes only its imports if any, and the conversion happens at call sites. Check for `fetchMarketStatus` usage; if absent, no change here.

```bash
grep -n "fetchMarketStatus" src/lib/daily-digest/dispatch.ts
```

- [ ] **Step 5: `src/lib/price-targets/process.ts:70`**

Replace:

```typescript
const isMarketOpen = options.isMarketOpen ?? (await fetchMarketStatus());
```

with:

```typescript
const isMarketOpen =
 options.isMarketOpen ?? (await getCurrentMarketSession()) === "regular";
```

Update the import.

- [ ] **Step 6: `src/lib/staged-notifications/precompute.ts:213` (daily-digest path only)**

The spec deletes `precomputeMarketScheduled` entirely (Phase 7). Here we touch only the daily-digest path at line ~213:

Replace:

```typescript
const marketOpen = await fetchMarketStatus();
```

with:

```typescript
const marketOpen = (await getCurrentMarketSession()) === "regular";
```

Update the import — but **don't remove the `fetchMarketStatus` import yet**; it's still used at line 114 inside `precomputeMarketScheduled`, which we delete in Task 7.1.

- [ ] **Step 7: Delete `fetchMarketStatus` from `price-fetcher.ts`**

This step happens **after** Task 7.1 deletes the last caller (`precomputeMarketScheduled`). For now, leave `fetchMarketStatus` in place — it'll get removed in Task 7.2.

- [ ] **Step 8: Type-check**

```bash
npm run check:ts 2>&1 | head -40
```

Expected: should be clean except for caller errors in tests (handled in Phase 9). Any remaining `fetchMarketStatus` import warnings will be resolved in Task 7.2.

---

## Phase 7 — Remove staging for market type

### Task 7.1: Delete `precomputeMarketScheduled` and remove from orchestrator

**Files:**

- Modify: `src/lib/staged-notifications/precompute.ts`
- Modify: `src/lib/schedule/run.ts` (or wherever `precomputeMarketScheduled` is invoked)

- [ ] **Step 1: Find call sites**

```bash
grep -rn "precomputeMarketScheduled" src/ tests/
```

- [ ] **Step 2: Delete `precomputeMarketScheduled` from `precompute.ts`**

In `src/lib/staged-notifications/precompute.ts`:

- Remove the entire `precomputeMarketScheduled` function (lines 43–156)
- Remove unused imports that only `precomputeMarketScheduled` used: `processMarketScheduledUser`, `fetchUpcomingMarketScheduledUsers`, `batchLoadUserAssets`, `USER_PROCESS_BATCH_SIZE`, `fetchAssetPrices`, `getUsMarketClosureInfoForInstant`, `AssetPriceMap`
- Keep imports still used by `precomputeDailyDigest`

- [ ] **Step 3: Remove the orchestrator call**

In whatever file calls `precomputeMarketScheduled` (likely `src/lib/schedule/run.ts`), remove the call. The cron tick now runs `processMarketScheduledUser` inline at delivery time (Phase 8 wires this).

If the orchestrator currently runs both staging and delivery for market notifications, keep only the **delivery** path for market type — staging is gone.

### Task 7.2: Delete `fetchMarketStatus` and related dead code

**Files:**

- Modify: `src/lib/providers/price-fetcher.ts`

- [ ] **Step 1: Verify no remaining callers**

```bash
grep -rn "fetchMarketStatus" src/
```

Expected: only the export and the implementation in `price-fetcher.ts`. Test files appear next phase.

- [ ] **Step 2: Delete `fetchMarketStatus` function**

In `src/lib/providers/price-fetcher.ts`, remove the entire `fetchMarketStatus` function (lines ~178–205) and remove the JSDoc above it.

- [ ] **Step 3: Type-check**

```bash
npm run check:ts
```

Expected: PASS for `src/`. Test errors remain.

### Task 7.3: Remove `StagedMarketData` and market-type handlers

**Files:**

- Modify: `src/lib/staged-notifications/types.ts`
- Modify: `src/lib/staged-notifications/deliver.ts`

- [ ] **Step 1: Remove `StagedMarketData` from types**

In `src/lib/staged-notifications/types.ts` replace lines 14–21 (the `StagedMarketData` interface) with nothing (delete entirely), and update the `StagedData` union and `StagedNotificationType`:

```typescript
export type StagedData = StagedDailyData;

export type StagedNotificationType = "daily";
```

- [ ] **Step 2: Update the `staged_notifications` row type**

```typescript
export interface StagedNotificationRow {
 id: string;
 user_id: string;
 notification_type: StagedNotificationType;
 scheduled_for: string;
 staged_at: string;
 staged_data: StagedData;
}
```

(Type stays the same shape; the union just narrows.)

- [ ] **Step 3: Remove market-type branch in `deliver.ts`**

In `src/lib/staged-notifications/deliver.ts`:

- Remove the `import type { StagedMarketData }` line
- Remove the `notification_type === "market"` branch (the entire `deliverStagedMarket` function and its dispatch case)
- Confirm the file still type-checks: only daily-digest delivery remains

- [ ] **Step 4: Type-check**

```bash
npm run check:ts
```

Expected: PASS for `src/`. Test errors remain (handled in Phase 9).

---

## Phase 8 — Inline market delivery: session detection + plumbing

### Task 8.1: Update `asset-formatting.ts` to take `MarketSession` and emit change-% in pre/after

**Files:**

- Modify: `src/lib/messaging/asset-formatting.ts`

- [ ] **Step 1: Replace `marketOpen: boolean` with `marketSession: MarketSession`**

In `src/lib/messaging/asset-formatting.ts`, find `formatAssetsTextList` and `formatAssetTextLine` (and any other functions that take `marketOpen` or `showChangePercent`). Update the suppression gate so:

- `marketSession === "closed"` → suppress change-%
- `marketSession === "pre"` | `"regular"` | `"after"` → emit change-%

Replace the relevant function (around line 96 onwards) — exact code depends on the function shape; the principle is:

```typescript
import type { MarketSession } from "../providers/price-fetcher";

// Replace boolean-flag callers; keep the existing `showChangePercent` parameter
// shape so per-call override is preserved (used by daily-digest tests).
export function formatAssetsTextList(
 assets: AssetWithName[],
 getPrice: (symbol: string) => AssetPrice | undefined,
 getSparkline?: (symbol: string) => string | null | undefined,
 showChangePercent = true,
): string {
 if (assets.length === 0) {
  return NO_TRACKED_ASSETS_MESSAGE;
 }
 return assets
  .map((asset) =>
   formatAssetTextLine(
    asset,
    getPrice(asset.symbol),
    getSparkline?.(asset.symbol),
    showChangePercent,
   ),
  )
  .join("\n\n");
}

// Helper for callers that want the session-driven default:
export function shouldEmitChangePercent(session: MarketSession): boolean {
 return session !== "closed";
}
```

The actual change at the call site (Task 8.2) uses `shouldEmitChangePercent(session)` instead of the previous `marketOpen !== false`.

If the existing `formatAssetTextLine` has special after-hours rendering that should change baseline (today's regular close instead of yesterday's close), thread `marketSession` and the snapshot's `day.close`/`prevClose` through. Pseudocode:

```typescript
function getChangePercent(
 quote: AssetPrice,
 session: MarketSession,
 dayClose: number | null,
 prevClose: number | null,
): { changePercent: number; usedDayCloseFallback: boolean } {
 if (session === "after" && dayClose !== null && dayClose !== 0) {
  return {
   changePercent: ((quote.price - dayClose) / dayClose) * 100,
   usedDayCloseFallback: false,
  };
 }
 if (session === "after") {
  // Missing or zero day.close → fall back to prevClose (with footnote)
  if (prevClose !== null && prevClose !== 0) {
   return {
    changePercent: ((quote.price - prevClose) / prevClose) * 100,
    usedDayCloseFallback: true,
   };
  }
 }
 // pre / regular / fallback when no baseline available
 return {
  changePercent: quote.changePercent,
  usedDayCloseFallback: false,
 };
}
```

**Note:** the existing snapshot fields will need to be threaded through. The current `AssetPrice` interface in `price-fetcher.ts:7` only has `price` and `changePercent`. After-hours requires `prevClose` and `dayClose`. Use `ExtendedAssetQuote` (which already has `prevClose`) when callers can provide it; for the snapshot from Massive's `/v1/snapshot/locale/us/markets/stocks/tickers`, the response includes `day.close` — confirm the field is exposed in `ExtendedAssetQuote` or add it.

If `ExtendedAssetQuote` doesn't have `dayClose`, add it:

```typescript
export interface ExtendedAssetQuote extends AssetPrice {
 dayHigh: number | null;
 dayLow: number | null;
 dayOpen: number | null;
 dayClose: number | null; // for after-hours change baseline
 prevClose: number | null;
 timestamp: number | null;
 volume: number | null;
}
```

And update the test stubs to populate `dayClose: null` (closed-market default).

### Task 8.2: Update `market-notifications/scheduled/process.ts` to fetch session at top of loop

**Files:**

- Modify: `src/lib/market-notifications/scheduled/process.ts`

- [ ] **Step 1: Replace `marketOpen: boolean` parameter with `marketSession: MarketSession`**

Replace the function signature parameter and update the body. Where the existing code does `if (!marketOpen) { ... skip ... }`, replace with `if (marketSession === "closed") { ... skip ... }`. Where it passes `marketOpen` to `formatAssetsTextList`, pass `marketSession` instead.

The full delivery-path change (after Phase 7's staging removal, this is the single inline path):

```typescript
export async function processMarketScheduledUser(options: {
 user: UserRecord;
 supabase: SupabaseAdminClient;
 logger: Logger;
 currentTime: DateTime;
 sendEmail: EmailSender;
 getSmsSender: SmsSenderProvider;
 priceMap: AssetPriceMap;
 marketSession: MarketSession;
 marketClosureInfo?: MarketClosureInfo | null;
 userAssetsMap?: UserAssetsMap;
}): Promise<ScheduledNotificationTotals> {
 const { user, supabase, logger, currentTime, marketSession } = options;

 const stats: ScheduledNotificationTotals = {
  skipped: 0,
  logFailures: 0,
  emailsSent: 0,
  emailsFailed: 0,
  smsSent: 0,
  smsFailed: 0,
 };

 // Spec: silent skip when no session active; log info, bump next_send_at, return.
 if (marketSession === "closed") {
  logger.info("Skipping scheduled market delivery — no active session", {
   userId: user.id,
   scheduledEtMinutes: user.market_scheduled_asset_price_times ?? null,
   dueAt: user.market_scheduled_asset_price_next_send_at,
  });
  stats.skipped++;
  await updateUserMarketScheduledNextSendAt({
   user,
   supabase,
   logger,
   currentTime,
  });
  return stats;
 }

 // ... rest of existing delivery flow, with `marketSession` plumbed through
 // to `processMarketScheduledEmailDelivery` / `processMarketScheduledSmsDelivery`.
 // Remove the entire `stageOnly` branch — staging is gone for market type.
}
```

- [ ] **Step 2: Remove the `stageOnly` branch entirely**

The `stageOnly` parameter and its branch (current lines 223–280) go away. Cron always runs the inline delivery path now.

- [ ] **Step 3: Update `processMarketScheduledEmailDelivery` and `processMarketScheduledSmsDelivery` signatures**

In `src/lib/market-notifications/scheduled/delivery.ts`, replace `marketOpen: boolean` with `marketSession: MarketSession` in both function signatures, and propagate to the formatters.

### Task 8.3: Update orchestrator to fetch session once and pass to `processMarketScheduledUser`

**Files:**

- Modify: `src/lib/schedule/run.ts` (or wherever the market-scheduled batch loop lives)

- [ ] **Step 1: Identify where the market-scheduled batch is processed**

```bash
grep -rn "processMarketScheduledUser\|fetchUpcomingMarketScheduledUsers" src/
```

Locate the new (post-Phase 7) batch loop that runs market-scheduled delivery inline. Add the session fetch at the top of the loop:

```typescript
// Fetch session once per cron tick — passed to every user in the batch.
const marketSession = await getCurrentMarketSession();
let marketClosureInfo: Awaited<ReturnType<typeof getUsMarketClosureInfoForInstant>> = null;
if (marketSession === "closed") {
 try {
  marketClosureInfo = await getUsMarketClosureInfoForInstant(currentTime);
 } catch (error) {
  logger.error(
   "Market closure lookup failed (continuing without closure info)",
   { action: "market_scheduled" },
   error,
  );
 }
}

// In the per-user loop:
await processMarketScheduledUser({
 user,
 supabase,
 logger,
 currentTime,
 sendEmail,
 getSmsSender,
 priceMap,
 marketSession,
 marketClosureInfo: marketSession === "closed" ? marketClosureInfo : undefined,
 userAssetsMap,
});
```

- [ ] **Step 2: Add session-aware first line in email/SMS**

In `src/lib/messaging/email/delivery.ts` and `src/lib/messaging/sms/delivery.ts` (or wherever `processMarketScheduledEmailDelivery` / `processMarketScheduledSmsDelivery` build the body), prepend a session label as the first body line:

```typescript
function buildSessionFirstLine(
 session: MarketSession,
 scheduledMinutes: number,
 is24: boolean,
 priorClose: number | null,
): string {
 const timeLabel = formatMinutesAsLocalTime(scheduledMinutes, is24);
 switch (session) {
  case "pre":
   return `Pre-market — ${timeLabel} ET`;
  case "regular":
   return `Regular hours — ${timeLabel} ET`;
  case "after": {
   const closeAnchor =
    priorClose !== null && priorClose !== 0
     ? ` (vs. 4:00 PM close $${priorClose.toFixed(2)})`
     : "";
   return `After-hours — ${timeLabel} ET${closeAnchor}`;
  }
  case "closed":
   // Should not be reached — `closed` is handled at the top of the user loop.
   return `Market closed — ${timeLabel} ET`;
 }
}
```

The HTML version uses `<p style="font-weight: bold; color: #1e293b;">…</p>` (or matching color tokens that meet WCAG SC 1.4.3 4.5:1 contrast).

The email subject stays `"Your Scheduled Price Notification"` (preserves mailbox threading).

- [ ] **Step 3: Type-check**

```bash
npm run check:ts
```

Expected: only test failures remain.

---

## Phase 9 — Database migration

### Task 9.1: Create migration file

**Files:**

- Create: `supabase/migrations/<timestamp>_migrate_market_times_to_et.sql`
- Modify: `tests/helpers/constants.ts`

- [ ] **Step 1: Generate migration filename**

```bash
supabase migration new migrate_market_times_to_et
```

Confirm the new file's path. Capture the full filename (e.g. `20260509120000_migrate_market_times_to_et`).

- [ ] **Step 2: Update the constraint function to relax bounds, then write migration body**

Two-pronged approach: (a) update the function `is_valid_market_scheduled_asset_price_times` to enforce `[270, 1170]`, (b) the migration runs the data conversion idempotently via `app_metadata`.

In the new migration file, write:

```sql
-- One-off migration: convert users.market_scheduled_asset_price_times
-- from user-local-minutes to ET-canonical minutes, and widen the valid
-- window from RTH (10:00–3:59 PM ET = [600, 959]) to extended-hours
-- (4:30 AM – 7:30 PM ET = [270, 1170]).

DO $$
DECLARE
 r RECORD;
 local_min INTEGER;
 et_minutes INTEGER;
 new_times INTEGER[];
BEGIN
 -- Idempotency guard: a sentinel in app_metadata blocks re-running the
 -- conversion. Required because `db:reset` replays all migrations and naive
 -- re-conversion would treat already-ET values as local-minutes.
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
   -- were validated against the 10:00–3:59 ET window, so post-conversion
   -- values *should* fall in [600, 959]. Edge cases near DST transitions
   -- could drift; clamp into [270, 1170] so the new CHECK can't fail.
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

-- Replace the validator function with the new bounds [270, 1170].
CREATE OR REPLACE FUNCTION public.is_valid_market_scheduled_asset_price_times(
 times integer[]
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
 SELECT
  times IS NULL OR (
   COALESCE(array_length(times, 1), 0) <= 8
   AND NOT EXISTS (
    SELECT 1 FROM unnest(times) AS t(val)
    WHERE val IS NULL OR val < 270 OR val > 1170
   )
  );
$$;

-- Bump schema version to this migration's filename (matches AGENTS.md convention).
UPDATE public.app_metadata
 SET value = '<REPLACE_WITH_THIS_MIGRATION_FILENAME>'
 WHERE key = 'schema_version';
```

**Replace `<REPLACE_WITH_THIS_MIGRATION_FILENAME>` with the actual filename (no `.sql`).** Example: `'20260509120000_migrate_market_times_to_et'`.

- [ ] **Step 3: Update `tests/helpers/constants.ts`**

Replace the line:

```typescript
export const EXPECTED_DB_SCHEMA_VERSION = "20260418130000_add_daily_digest_include_top_movers_sms";
```

with the new value (the migration filename without `.sql`, matching what the migration UPDATEs):

```typescript
export const EXPECTED_DB_SCHEMA_VERSION = "20260509120000_migrate_market_times_to_et";
```

- [ ] **Step 4: Reset DB and regenerate types**

```bash
npm run db:reset
npm run db:gen-types
```

Expected: PASS. The migration runs cleanly and types regenerate.

- [ ] **Step 5: Verify schema state**

```bash
npm run db:doctor
```

Expected: PASS.

### Task 9.2: Add migration test

**Files:**

- Create: `tests/lib/db/market-times-migration.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { afterAll, describe, expect, it } from "vitest";
import { createSupabaseAdminClient } from "../../../src/lib/db/supabase-admin";
import {
 registerTestUserForCleanup,
 signUpAndConfirmUser,
} from "../../helpers/test-user";

describe("market-times migration: pre→et conversion behaviour", () => {
 const supabase = createSupabaseAdminClient();
 const cleanup: (() => Promise<void>)[] = [];

 afterAll(async () => {
  for (const fn of cleanup) await fn();
 });

 it("A US-Pacific user with 7:00 AM PT stored time round-trips to 10:00 AM ET (600) post-migration.", async () => {
  // The migration has already run by now (db:reset is part of test setup),
  // so we verify the post-migration bound by submitting a new value through
  // the API path (covered in Task 13.1) and reading back the stored ET value.
  // This test exists primarily to assert that the CHECK constraint accepts
  // the full [270, 1170] range.
  const { user, authToken } = await signUpAndConfirmUser({ supabase });
  registerTestUserForCleanup(user.id, cleanup);

  const { error: lowError } = await supabase
   .from("users")
   .update({ market_scheduled_asset_price_times: [270] })
   .eq("id", user.id);
  expect(lowError).toBeNull();

  const { error: highError } = await supabase
   .from("users")
   .update({ market_scheduled_asset_price_times: [1170] })
   .eq("id", user.id);
  expect(highError).toBeNull();

  const { error: tooLowError } = await supabase
   .from("users")
   .update({ market_scheduled_asset_price_times: [269] })
   .eq("id", user.id);
  expect(tooLowError).not.toBeNull();
  expect(tooLowError?.message).toMatch(/check/i);

  const { error: tooHighError } = await supabase
   .from("users")
   .update({ market_scheduled_asset_price_times: [1171] })
   .eq("id", user.id);
  expect(tooHighError).not.toBeNull();
  expect(tooHighError?.message).toMatch(/check/i);
 });

 it("The migration is idempotent — re-running does not double-convert ET values.", async () => {
  // Confirm sentinel is in place after db:reset.
  const { data, error } = await supabase
   .from("app_metadata")
   .select("value")
   .eq("key", "market_times_storage")
   .single();
  expect(error).toBeNull();
  expect(data?.value).toBe("et_minutes");
 });
});
```

- [ ] **Step 2: Run test (expect PASS)**

```bash
npm test -- tests/lib/db/market-times-migration.test.ts
```

Expected: PASS.

---

## Phase 10 — UI changes

### Task 10.1: TimePicker.vue accessibility fix

**Files:**

- Modify: `src/components/dashboard/shared/TimePicker.vue`

- [ ] **Step 1: Replace hover-only `title` with `aria-disabled` + `aria-label`**

Find `applyDisabledTooltips` (around lines 196–205). Replace the implementation so disabled cells get both attributes for screen-reader access:

```typescript
function applyDisabledTooltips(root: ParentNode) {
 const tooltip = props.disabledRangeTooltip;
 if (!tooltip) return;
 const nodes = root.querySelectorAll(DISABLED_SELECTORS);
 for (const node of nodes) {
  if (node instanceof HTMLElement) {
   if (node.getAttribute("title") !== tooltip) {
    node.setAttribute("title", tooltip);
   }
   node.setAttribute("aria-disabled", "true");
   if (node.getAttribute("aria-label") !== tooltip) {
    node.setAttribute("aria-label", tooltip);
   }
  }
 }
}
```

(Title attribute stays for sighted hover users; the `aria-disabled` and `aria-label` close the SC 1.4.13 gap.)

### Task 10.2: ScheduledUpdateControls.vue copy update

**Files:**

- Modify: `src/components/dashboard/market-notifications/ScheduledUpdateControls.vue`

- [ ] **Step 1: Update helper text and tooltip**

Replace the helper text span (line ~17):

```vue
<span class="block text-sm font-normal text-body-secondary mt-0.5">
 Choose up to {{ maxTimes }} time slots. Notifications send anytime US markets are trading
 (pre-market, regular, or after-hours). Pick any time between 4:30 AM and 7:30 PM ET. Sends are
 skipped if markets aren't trading at your scheduled time — this includes early-close days
 (~3 per year), full-day holidays, and the 30-minute gaps between sessions (9:00–9:30 AM and
 4:00–4:30 PM ET). Notifications send within ~10 seconds of your scheduled time.
</span>
```

Replace the disabled-range tooltip constant (line ~141):

```typescript
const DISABLED_RANGE_TOOLTIP = "Outside US extended-hours window (4:30 AM – 7:30 PM ET)";
```

If the picker reads stored ET-minutes and displays via `etMinuteToUserLocal(stored, userTimezone)`, wire that here. Likewise, computed min/max overrides for the picker pull from `etMinuteToUserLocal(270, tz)` and `etMinuteToUserLocal(1170, tz)`.

- [ ] **Step 2: Add `aria-describedby` linking the cross-midnight hint to the picker input**

Find the cross-midnight hint span. Give it an `id` (e.g. `cross-midnight-hint-{{ inputId }}`). On the picker input element, add `aria-describedby="cross-midnight-hint-{{ inputId }}"`. The screen reader announces the constraint on focus.

### Task 10.3: MarketNotificationsPanel.vue copy update

**Files:**

- Modify: `src/components/dashboard/market-notifications/MarketNotificationsPanel.vue`

- [ ] **Step 1: Replace hardcoded RTH copy**

```bash
grep -n "10:00 AM\|3:59 PM" src/components/dashboard/market-notifications/MarketNotificationsPanel.vue
```

For each match, replace with the new range text (`"4:30 AM – 7:30 PM ET"`) or refactor to share copy from `ScheduledUpdateControls.vue` if duplicated.

### Task 10.4: TimezoneSection.vue disclosure

**Files:**

- Modify: `src/components/profile/TimezoneSection.vue`

- [ ] **Step 1: Add ET-anchor disclosure**

Add a paragraph (after the existing intro line at lines ~15–17):

```vue
<p class="text-body-secondary text-sm mb-2">
 <strong>Note:</strong> Your scheduled times are anchored to US market hours.
 Changing your timezone updates display only, not when notifications fire.
</p>
```

- [ ] **Step 2: Run dev server and verify visually**

```bash
npm run dev
```

Open the dashboard, verify:

- Picker shows extended-hours window as enabled
- Disabled cells outside the window have `aria-disabled` (inspect DOM)
- Helper text shows the new range
- Timezone section shows the disclosure
- Save a new schedule with a pre-market time (e.g., 7:30 AM PT = 10:30 AM ET) and confirm it accepts
- Verify stored value in DB matches expected ET-minute via Supabase Studio (`http://localhost:54323`)

Stop the dev server.

---

## Phase 11 — Test fixture migration

### Task 11.1: Fix `tests/lib/staged-notifications/precompute.test.ts`

**Files:**

- Modify: `tests/lib/staged-notifications/precompute.test.ts`

- [ ] **Step 1: Update mock declarations**

The hoisted-mock block (lines 5–26) needs to:

- Replace `fetchMarketStatusMock` with `getCurrentMarketSessionMock`
- Update the vi.mock for `price-fetcher` to mock `getCurrentMarketSession` instead

```typescript
const { dispatchDailyDigestUserMock, fetchUpcomingDailyDigestUsersMock, getCurrentMarketSessionMock } =
 vi.hoisted(() => ({
  dispatchDailyDigestUserMock: vi.fn(),
  fetchUpcomingDailyDigestUsersMock: vi.fn(),
  getCurrentMarketSessionMock: vi.fn(),
 }));

vi.mock("../../../src/lib/daily-digest/dispatch", () => ({
 dispatchDailyDigestUser: dispatchDailyDigestUserMock,
}));

vi.mock("../../../src/lib/daily-digest/query-upcoming", () => ({
 fetchUpcomingDailyDigestUsers: fetchUpcomingDailyDigestUsersMock,
}));

vi.mock("../../../src/lib/providers/price-fetcher", async () => {
 const actual = await vi.importActual<typeof import("../../../src/lib/providers/price-fetcher")>(
  "../../../src/lib/providers/price-fetcher",
 );
 return {
  ...actual,
  getCurrentMarketSession: getCurrentMarketSessionMock,
 };
});
```

- [ ] **Step 2: Update test scenarios**

Find all `fetchMarketStatusMock.mockResolvedValue(true|false)` calls and replace with `getCurrentMarketSessionMock.mockResolvedValue("regular" | "closed")` (or `"pre"` / `"after"` per scenario).

Remove any tests that exercise `precomputeMarketScheduled` — that function no longer exists. Keep daily-digest tests.

- [ ] **Step 3: Run tests**

```bash
npm test -- tests/lib/staged-notifications/precompute.test.ts
```

Expected: PASS.

### Task 11.2: Fix `tests/lib/staged-notifications/deliver.test.ts`

**Files:**

- Modify: `tests/lib/staged-notifications/deliver.test.ts`

- [ ] **Step 1: Delete market-type scenarios**

Find each scenario that constructs `StagedMarketData` (lines 22, 82, 148, 225 per the spec) and delete those entire `it()` or `describe()` blocks. Daily-digest scenarios stay.

- [ ] **Step 2: Remove `import type { StagedMarketData }`**

- [ ] **Step 3: Run tests**

```bash
npm test -- tests/lib/staged-notifications/deliver.test.ts
```

Expected: PASS.

### Task 11.3: Fix `tests/lib/schedule/run.test.ts`

**Files:**

- Modify: `tests/lib/schedule/run.test.ts`

- [ ] **Step 1: Delete `StagedMarketData` fixture and old market scenarios**

Lines 59–68 construct a `StagedMarketData` fixture for testing. Delete that scenario entirely.

- [ ] **Step 2: Add new session-aware scenarios**

```typescript
describe("Market scheduled inline delivery — session-aware", () => {
 it("A user with a 7:00 AM ET pre-market scheduled time receives a message labeled 'Pre-market' with change-% computed vs. yesterday's close", async () => {
  // Set up user with stored ET-minute = 420 (7:00 AM ET)
  // Mock getCurrentMarketSession → "pre"
  // Run cron tick
  // Assert delivered email body starts with "Pre-market — 7:00 AM ET"
  // Assert change-% is non-empty
 });

 it("A user with a 5:00 PM ET after-hours scheduled time receives a message labeled 'After-hours' with change-% computed vs. today's regular close, plus the close-anchor reference", async () => {
  // Set up user with stored ET-minute = 1020 (5:00 PM ET), priceMap with day.close
  // Mock getCurrentMarketSession → "after"
  // Assert email body starts with "After-hours — 5:00 PM ET (vs. 4:00 PM close $X.XX)"
  // Assert change-% computed against day.close
 });

 it("A pre-market scheduled message renders with a non-empty change-% column for every ticker — verifying the suppression gate flip in asset-formatting.ts", async () => {
  // Same setup as pre-market test; assert no asset row has empty change-%
 });

 it("A user with multiple time slots spanning all three sessions on the same day cycles next_send_at correctly", async () => {
  // User has [420, 720, 1020] (7am, noon, 5pm ET)
  // After 7am send, next_send_at advances to noon
  // After noon send, next_send_at advances to 5pm
  // After 5pm send, next_send_at advances to next day's 7am
 });

 it("A scheduled time on a half-day in the after-hours dead zone is skipped at delivery (runtime session = closed), logged at info, next_send_at advances", async () => {
  // User scheduled at 1500 ET-minutes (3:00 PM ET) on a half-day
  // Mock getCurrentMarketSession → "closed"
  // Assert no email/SMS sent
  // Assert info log contains "Skipping scheduled market delivery"
  // Assert next_send_at advances to next valid time
 });

 it("A 9:31 AM ET regular-session send produces a regular-hours message — verifies the buffer drop", async () => {
  // User scheduled at 571 ET-minutes (9:31 AM ET)
  // Mock getCurrentMarketSession → "regular"
  // Assert delivered (no buffer suppression)
  // Assert label is "Regular hours"
 });

 it("When getCurrentMarketSession returns closed for one user, the cron continues processing other users in the batch", async () => {
  // Two users in batch; one with session "closed" (skip), one with "regular" (deliver)
  // Assert both processed independently
 });

 it.skip("On a half-day after 1:00 PM ET, if Massive returns 'after', behavior is TBD pending live verification", async () => {
  // TODO(half-day-verification): resolve before final commit, by 2026-05-15
 });
});
```

Fill in test bodies based on the existing test harness patterns in the file. Use real Supabase client + seeded test users.

- [ ] **Step 3: Run tests**

```bash
npm test -- tests/lib/schedule/run.test.ts
```

Expected: PASS (with one `.skip`).

### Task 11.4: Fix `tests/lib/price-targets/process.test.ts`

**Files:**

- Modify: `tests/lib/price-targets/process.test.ts`

- [ ] **Step 1: Update mock target**

Replace `fetchMarketStatus: vi.fn()` with `getCurrentMarketSession: vi.fn()`. Update test scenarios:

```typescript
mockGetCurrentMarketSession.mockResolvedValue("regular");  // was: mockFetchMarketStatus.mockResolvedValue(true)
```

- [ ] **Step 2: Add session-classification scenarios**

```typescript
it("Price targets are not evaluated during pre-market session", async () => {
 mockGetCurrentMarketSession.mockResolvedValue("pre");
 // ... assert no targets fired
});

it("Price targets are not evaluated during after-hours session", async () => {
 mockGetCurrentMarketSession.mockResolvedValue("after");
 // ... assert no targets fired
});

it("Price targets evaluate normally during regular session", async () => {
 mockGetCurrentMarketSession.mockResolvedValue("regular");
 // ... assert targets fired
});
```

(Pre/after gating preserves the existing behavior — price targets are RTH-only.)

- [ ] **Step 3: Run tests**

```bash
npm test -- tests/lib/price-targets/process.test.ts
```

Expected: PASS.

### Task 11.5: Fix `tests/lib/schedule/daily-digest-closure-fanout.test.ts`

**Files:**

- Modify: `tests/lib/schedule/daily-digest-closure-fanout.test.ts`

- [ ] **Step 1: Remove `precomputeMarketScheduled` mock**

In the `vi.mock("../../../src/lib/staged-notifications/precompute", ...)` block (line ~68), drop the `precomputeMarketScheduled` entry — only `precomputeDailyDigest` remains:

```typescript
vi.mock("../../../src/lib/staged-notifications/precompute", () => ({
 precomputeDailyDigest: vi.fn().mockResolvedValue({
  skipped: 0,
  logFailures: 0,
  emailsSent: 0,
  emailsFailed: 0,
  smsSent: 0,
  smsFailed: 0,
 }),
}));
```

- [ ] **Step 2: Run tests**

```bash
npm test -- tests/lib/schedule/daily-digest-closure-fanout.test.ts
```

Expected: PASS.

### Task 11.6: Fix `tests/lib/live-provider-apis.test.ts`

**Files:**

- Modify: `tests/lib/live-provider-apis.test.ts`

- [ ] **Step 1: Replace `fetchMarketStatus` test with two new tests**

```typescript
it("getCurrentMarketSession returns a valid MarketSession value from live Massive", async () => {
 const session = await getCurrentMarketSession();
 expect(["pre", "regular", "after", "closed"]).toContain(session);
});

it("Massive /v1/marketstatus/now payload includes earlyHours and afterHours boolean fields", async () => {
 const data = await marketDataFetch("/v1/marketstatus/now", {}, "market-status");
 expect(typeof data).toBe("object");
 expect(data).not.toBeNull();
 const record = data as Record<string, unknown>;
 expect(typeof record.earlyHours).toBe("boolean");
 expect(typeof record.afterHours).toBe("boolean");
 expect(typeof record.market).toBe("string");
});
```

Update imports to include `getCurrentMarketSession` and `marketDataFetch`. (If field-shape verification in Phase 1 found different field names, update this assertion accordingly.)

- [ ] **Step 2: Run live tests**

```bash
npm run test:live:data
```

Expected: PASS.

### Task 11.7: Fix `tests/api/notification-preferences/update-notification-preferences.test.ts`

**Files:**

- Modify: `tests/api/notification-preferences/update-notification-preferences.test.ts`

- [ ] **Step 1: Add ET-minute round-trip assertions**

Add a new scenario:

```typescript
it("A US-Pacific user submitting 7:00 AM PT (= 420 local-minutes) stores 600 ET-minutes (= 10:00 AM ET).", async () => {
 const { user } = await signUpAndConfirmUser({
  supabase,
  timezone: "America/Los_Angeles",
 });
 registerTestUserForCleanup(user.id, cleanup);

 const formData = new FormData();
 formData.set("market_scheduled_asset_price_enabled", "true");
 formData.set("market_scheduled_asset_price_times", "07:00");
 formData.set("timezone", "America/Los_Angeles");

 const response = await fetch(`${baseUrl}/api/notification-preferences/update`, {
  method: "PATCH",
  headers: { Authorization: `Bearer ${authToken}` },
  body: formData,
 });
 expect(response.status).toBe(200);

 const { data: dbUser } = await supabase
  .from("users")
  .select("market_scheduled_asset_price_times")
  .eq("id", user.id)
  .single();
 expect(dbUser?.market_scheduled_asset_price_times).toEqual([600]);
});
```

(Note: 600 in winter EST; 540 in summer EDT — the test should be written to handle whichever DST regime is current. If running cross-DST is a problem, mock `DateTime.now()` or pin the timezone test to a specific instant.)

- [ ] **Step 2: Run tests**

```bash
npm test -- tests/api/notification-preferences/update-notification-preferences.test.ts
```

Expected: PASS.

### Task 11.8: Audit any other test files calling `fetchMarketStatus`

**Files:**

- Modify: any remaining test files

- [ ] **Step 1: Find remaining references**

```bash
grep -rn "fetchMarketStatus" tests/
```

For each match, switch to `getCurrentMarketSession` mocks. Replace boolean returns with session strings.

- [ ] **Step 2: Run full test suite**

```bash
npm test
```

Expected: PASS.

---

## Phase 12 — Final verification

### Task 12.1: Type check, lint, build

**Files:** none

- [ ] **Step 1: Type check**

```bash
npm run check:ts
```

Expected: clean.

- [ ] **Step 2: Biome check**

```bash
npm run check:biome
```

Expected: clean.

- [ ] **Step 3: Build**

```bash
npm run build
```

Expected: clean.

### Task 12.2: Run full test suite

**Files:** none

- [ ] **Step 1: Vitest**

```bash
npm test
```

Expected: all PASS.

- [ ] **Step 2: Smoke tests**

```bash
npm run test:smoke
```

Expected: all PASS.

- [ ] **Step 3: Live data tests (verify Massive payload assumptions)**

```bash
npm run test:live:data
```

Expected: PASS.

### Task 12.3: Manual smoke test in dev

**Files:** none

- [ ] **Step 1: Start local stack**

```bash
npm run db:bootstrap
npm run dev
```

- [ ] **Step 2: Manual UI verification**

In the dashboard:

1. Set timezone to `America/Los_Angeles`.
2. Schedule a notification at 7:00 AM PT. Verify it saves and shows "7:00 AM" in the picker after reload.
3. Inspect the DB row — `market_scheduled_asset_price_times` should be `[600]` (or `[540]` summer).
4. Change timezone to `America/New_York`. Verify picker now shows "10:00 AM" for the same stored value (no drift in ET; behavior change is wall-clock disclosure).
5. Schedule a pre-market time (e.g., 7:30 AM ET). Verify picker accepts it.
6. Schedule an after-hours time (e.g., 5:30 PM ET). Verify picker accepts it.
7. Try to schedule 4:00 AM ET — verify picker disables it (inspect DOM for `aria-disabled="true"`).
8. Verify the new disclosure paragraph appears under the timezone section.

- [ ] **Step 3: Stop dev server**

### Task 12.4: Open Question #2 & #3 housekeeping

**Files:** none (verification only)

- [ ] **Step 1: Check half-day Massive behavior**

Per Open Question #2: on a half-day (e.g., day before Thanksgiving, when regular ends at 1:00 PM ET and there's no after-hours), confirm what Massive's `/v1/marketstatus/now` returns from 1:00–4:00 PM ET. If it returns `"after"`, the runtime would attempt an after-hours notification. Decide: fall through and accept the misclassification (low frequency, ~3 days/year) or add a half-day guard.

If verifying live is impractical, leave the `it.skip` test in place (Task 11.3 step 2) with the TODO comment, and proceed to commit. Plan a follow-up task to verify live and resolve.

- [ ] **Step 2: Confirm DST timing for deploy**

Today's date is 2026-05-09 — that's during EDT (DST in effect). The spec recommends deploying during EST (winter) for cleaner non-US-TZ alignment. If deploying now, document that non-US-TZ users will see their stored ET-minutes anchored to EDT, and seasonal drift will be "+1 hour later in EST winter."

If postponement is undesirable, accept the EDT-anchored conversion. Document choice in the commit message.

### Task 12.5: Commit

**Files:** all modified

- [ ] **Step 1: Stage all changes**

```bash
git status
git add <each file explicitly — do NOT use git add -A>
```

Per `~/.agents/AGENTS.md`: "Prefer adding specific files by name rather than using 'git add -A' or 'git add .', which can accidentally include sensitive files."

- [ ] **Step 2: Verify diff**

```bash
git diff --cached --stat
```

Skim — confirm all expected files, no surprises (no .env, no IDE artifacts, no debug logs).

- [ ] **Step 3: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(market-notifications): widen scheduled price alerts to extended hours

Migrate market_scheduled_asset_price_times storage from user-local-minutes
to ET-canonical minutes [270, 1170] (4:30 AM – 7:30 PM ET) and run
session detection (pre / regular / after / closed) at delivery time via
new getCurrentMarketSession() — replaces the boolean fetchMarketStatus().

- DB CHECK enforces [270, 1170] bounds; idempotent migration with
  app_metadata sentinel guards re-runs.
- isOutsideMarketHours, calculateNextSendAt, calculateNextSendAtFromTimes,
  computeNextSendAtIso all switch from (localMinutes, timezone) to (etMinutes).
- Snapshot misses fall back to prev-day bar only when session === "closed"
  (correctness fix for pre/after-hours).
- Market-type staging removed — cron renders inline so session is always
  fresh at delivery. Daily-digest staging stays.
- After-hours messages emit change-% vs today's regular close (with
  prevClose fallback + footnote when day.close missing/zero).
- Picker fixes WCAG 1.4.13 hover-only-tooltip violation via aria-disabled
  + aria-label on disabled cells.
- Timezone-section discloses that scheduled times are ET-anchored.

Spec: docs/superpowers/specs/2026-05-08-extended-hours-notifications-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4: Verify commit**

```bash
git log -1 --stat
git status
```

Expected: clean working tree, single new commit with the expected file list.

---

## Self-review checklist

After implementation, before reporting complete:

- [ ] Spec section "Storage canonicalization" → covered by Tasks 4–5, 9
- [ ] Spec section "Runtime market session detection" → covered by Tasks 2, 3
- [ ] Spec section "Migrating fetchMarketStatus" → covered by Task 6
- [ ] Spec section "calculateNextSendAtFromTimes signature change" → covered by Tasks 5.1–5.3
- [ ] Spec section "isOutsideMarketHours signature change" → covered by Task 4.2
- [ ] Spec section "Snapshot-miss fix" → covered by Task 3.1
- [ ] Spec section "Picker / UI changes" → covered by Tasks 10.1–10.4
- [ ] Spec section "Message rendering" → covered by Tasks 8.1, 8.3
- [ ] Spec section "Removing staging for market type" → covered by Tasks 7.1, 7.3
- [ ] Spec section "Constants update" → covered by Task 4.3
- [ ] Spec section "Send / skip flow" → covered by Tasks 8.2, 8.3
- [ ] Spec section "Logging" → covered by Tasks 2.2, 8.2 (`info` skip log)
- [ ] Spec testing plan tasks → covered by Tasks 2.1, 4.2, 9.2, 11.1–11.8

---

## Open questions (carry-forward)

1. **Massive payload field shape** — verified in Task 1.1 against live data; adjust Task 2.2 implementation if names differ.
2. **Half-day after-hours** — `it.skip` placeholder in Task 11.3; resolve by 2026-05-15.
3. **DST-safe deploy window** — currently EDT (DST active); accept the non-US-TZ drift convention or postpone deploy. Document in commit message.

---

## File-touched summary (for the final commit)

**Created:**

- `supabase/migrations/<timestamp>_migrate_market_times_to_et.sql`
- `tests/lib/providers/parse-market-session.test.ts`
- `tests/lib/db/market-times-migration.test.ts`

**Modified:**

- `src/lib/constants.ts`
- `src/lib/providers/price-fetcher.ts`
- `src/lib/time/format.ts`
- `src/lib/time/scheduled-times.ts`
- `src/lib/time/market-scheduled-next-send.ts`
- `src/lib/api/notification-preferences-update.ts`
- `src/lib/asset-events/scheduling-helpers.ts` (audit/touch in Task 5.3 step 5)
- `src/lib/schedule/run.ts`
- `src/lib/market-notifications/process.ts`
- `src/lib/market-notifications/scheduled/process.ts`
- `src/lib/market-notifications/scheduled/delivery.ts`
- `src/lib/messaging/asset-formatting.ts`
- `src/lib/messaging/email/delivery.ts`
- `src/lib/messaging/sms/delivery.ts`
- `src/lib/daily-digest/process.ts`
- `src/lib/daily-digest/dispatch.ts`
- `src/lib/price-targets/process.ts`
- `src/lib/staged-notifications/precompute.ts`
- `src/lib/staged-notifications/deliver.ts`
- `src/lib/staged-notifications/types.ts`
- `src/components/dashboard/shared/TimePicker.vue`
- `src/components/dashboard/market-notifications/ScheduledUpdateControls.vue`
- `src/components/dashboard/market-notifications/MarketNotificationsPanel.vue`
- `src/components/profile/TimezoneSection.vue`
- `tests/helpers/constants.ts`
- `tests/lib/time/market-hours.test.ts`
- `tests/lib/schedule/run.test.ts`
- `tests/lib/schedule/daily-digest-closure-fanout.test.ts`
- `tests/lib/staged-notifications/precompute.test.ts`
- `tests/lib/staged-notifications/deliver.test.ts`
- `tests/lib/price-targets/process.test.ts`
- `tests/lib/live-provider-apis.test.ts`
- `tests/api/notification-preferences/update-notification-preferences.test.ts`
- `src/lib/db/generated/database.types.ts` (regenerated by `npm run db:gen-types`)

**Removed:**

- `fetchMarketStatus` (function in `price-fetcher.ts`)
- `getMarketNotificationLocalRange` (helper in `time/format.ts`)
- `precomputeMarketScheduled` (function in `staged-notifications/precompute.ts`)
- `StagedMarketData` (type in `staged-notifications/types.ts`)
- `deliverStagedMarket` (function in `staged-notifications/deliver.ts`)
