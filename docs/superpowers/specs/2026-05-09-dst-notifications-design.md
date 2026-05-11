# DST notifications

**Status:** Design

**Date:** 2026-05-09

## Summary

Send a one-week-ahead heads-up email and/or SMS to all eligible users before each US daylight saving time shift (spring forward, 2nd Sunday of March; fall back, 1st Sunday of November). Message content adapts to whether the user's timezone shifts in lockstep with US Eastern (no impact on delivery times) or doesn't (delivery times appear to shift by 1 hour on the user's local clock).

A new dedicated Lambda fires twice a year via two EventBridge cron schedules — exactly on the day a notification is needed. Idempotency uses a new `users.dst_notice_sent_for_date` column. Channel gating reuses the existing per-user email/SMS preferences. No new opt-out toggle.

## Motivation

US DST shifts twice a year. Users on US-DST-aligned timezones (Eastern, Central, Mountain, Pacific) see no impact on their wall-clock alert delivery times — local clocks move with ET. Users on non-aligned timezones (Hawaii, most of Arizona, all non-US users on a different DST schedule) see their wall-clock delivery time appear to shift by 1 hour.

This is acutely relevant after the extended-hours notifications spec lands (`docs/superpowers/specs/2026-05-08-extended-hours-notifications-design.md`), which migrates `users.market_scheduled_asset_price_times` from user-local-minutes to ET-canonical minutes. That spec documents seasonal drift for non-US-DST-aligned timezones as accepted behavior. This DST notification feature is the in-app early warning of that documented drift.

The notification also serves as useful context for ET-aligned users — even when their delivery times don't change, a calendar reminder that "DST starts Sunday" is low-noise twice-a-year information for users tracking US markets.

## Audience

All users with at least one notification channel enabled (email or SMS). Specifically:

- **Email recipients:** users where `email_notifications_enabled = true`.
- **SMS recipients:** users where `isSmsChannelUsable(user)` returns true (`sms_notifications_enabled = true`, `phone_verified = true`, `sms_opted_out = false`).

A user with neither channel usable is filtered out by the eligibility query.

No new opt-out toggle. The cadence (twice a year) is low enough that the existing channel-level preferences are sufficient — a user wanting zero notifications can disable channels.

## Non-goals

- **Per-user-local DST shifts.** Only US DST events trigger this notification. A Berlin user gets the heads-up about US DST shifts but not about European DST shifts. Most affected users are US-based or US-aware (the product is US-equity-only); adding per-user DST tracking would multiply complexity for limited value.
- **Daily-digest-only users with no impact context.** `daily_digest_time` stays in user-local-minutes per the extended-hours spec, so daily digest delivery is DST-stable for everyone (the user's wall clock and their delivery time both stay aligned). The DST notification still goes to these users with the aligned-message template; we don't carve out a separate "you have no scheduled market times so this doesn't apply to you" branch.
- **Opt-in/opt-out per feature.** No new toggle. Channel-level preferences are the only gate.
- **Customizable lead time.** Always exactly 7 days before the shift. Not configurable.
- **Live SMS/email validation in tests.** The existing `messaging/email/utils.ts` and `messaging/sms/twilio-utils.ts` are already covered. This feature uses the same injected sender interfaces every other notification flow uses.

## Architecture overview

```text
┌─ Two EventBridge cron schedules ──────────────────────────┐
│  Spring: cron(0 12 ? 3 1#1 *)  → 1st Sun of March 12 UTC  │
│  Fall:   cron(0 12 ? 10 1L *)  → last Sun of Oct  12 UTC  │
│  Both attached to the same Lambda function.               │
└────────────────────────────────────────────────────────────┘
                          ↓
┌─ stocktextalerts-dst-notifications (new Lambda) ──────────┐
│  1. Detect manual-force payload via type guard.           │
│  2. Otherwise: compute next US DST shift; validate that   │
│     today is exactly shift_date - 7. If not, log info     │
│     and return (defensive).                               │
│  3. Fan out to runDstNotifications().                     │
└────────────────────────────────────────────────────────────┘
                          ↓
┌─ src/lib/dst-notifications/process.ts ────────────────────┐
│  Query eligible users not already marked for this shift.  │
│  For each: compute tz impact, render content, send via    │
│  enabled channels, mark dst_notice_sent_for_date on       │
│  success. Promise.allSettled per batch.                   │
└────────────────────────────────────────────────────────────┘
```

EventBridge cron is UTC-evaluated, but Sundays-of-month align between UTC and ET (ET is 4–5h behind UTC; same calendar day). 12:00 UTC = 7:00–8:00 AM ET, comfortably after midnight in every US timezone.

The Lambda re-validates the date defensively at runtime. If the cron config ever drifts or fires on the wrong day, the runtime check refuses to send.

### Why a dedicated Lambda

The existing `asset-events.ts` runs daily and was a candidate for piggyback. Twice-a-year cadence is too sparse to share infrastructure — separation of concerns, isolated alarms, and the cron expressions encode intent ("first Sunday of March" not "every day, check if today is special"). New-Lambda cost is one SAM block and a couple of CloudWatch alarms.

### Why two crons over one weekly cron

A weekly cron (`cron(0 12 ? * 1 *)`) would invoke 52×/year and gate internally. Two specific crons are 26× cheaper to reason about and result in exactly two CloudWatch invocations per year — easy to verify operationally.

## Data model

### Migration

`supabase/migrations/<timestamp>_add_dst_notice_sent_for_date.sql`:

```sql
ALTER TABLE public.users
  ADD COLUMN dst_notice_sent_for_date DATE;

UPDATE public.app_metadata
  SET value = '<filename_without_extension>'
  WHERE key = 'schema_version';
```

- **Nullable.** New users start `NULL`, which means "never notified." The eligibility query treats `NULL` as not-yet-marked via `IS DISTINCT FROM`.
- **No index.** Twice-a-year scan on a low-thousands-row user table — full scan is cheap.
- **No `NOT NULL`, no default.** `NULL` is the natural "never sent" sentinel; no need to backfill existing users.

After the migration: bump `EXPECTED_DB_SCHEMA_VERSION` in `tests/helpers/constants.ts` and run `npm run db:gen-types`.

### Eligibility query

```sql
SELECT id, email, timezone, email_notifications_enabled,
       sms_notifications_enabled, sms_opted_out, phone_verified,
       phone_country_code, phone_number, dst_notice_sent_for_date
FROM users
WHERE (email_notifications_enabled = true
       OR (sms_notifications_enabled = true
           AND phone_verified = true
           AND sms_opted_out = false))
  AND (dst_notice_sent_for_date IS DISTINCT FROM $1);
-- $1 = the upcoming shift date (DATE)
```

`IS DISTINCT FROM` correctly treats `NULL` as "different from any specific date," so first-time users are included.

## Internal modules

### `src/lib/dst-notifications/dst-dates.ts`

```ts
import { DateTime } from "luxon";

export interface UsDstShift {
    shiftDate: DateTime; // in America/New_York zone
    kind: "spring" | "fall";
}

/** Compute the next upcoming US DST shift relative to `now`. */
export function getNextUsDstShift(now: DateTime): UsDstShift {
    const year = now.setZone("America/New_York").year;
    const candidates: UsDstShift[] = [
        { shiftDate: nthSundayOfMonth(year, 3, 2), kind: "spring" },
        { shiftDate: nthSundayOfMonth(year, 11, 1), kind: "fall" },
        { shiftDate: nthSundayOfMonth(year + 1, 3, 2), kind: "spring" },
    ];
    const nowEt = now.setZone("America/New_York");
    return candidates.find((c) => c.shiftDate >= nowEt.startOf("day")) as UsDstShift;
}

function nthSundayOfMonth(year: number, month: number, n: number): DateTime {
    // First day of month in ET
    const first = DateTime.fromObject({ year, month, day: 1 }, { zone: "America/New_York" });
    // Luxon weekdays: Mon=1, Sun=7. Days to first Sunday:
    const offsetToFirstSunday = (7 - first.weekday) % 7;
    return first.plus({ days: offsetToFirstSunday + (n - 1) * 7 });
}
```

Pure date math. No external data. Deterministic.

### `src/lib/dst-notifications/tz-impact.ts`

```ts
import { DateTime } from "luxon";

export type DstImpact = "aligned" | "earlier" | "later";

/**
 * Determine how a user's wall-clock delivery time changes across the DST shift.
 *
 * Compares the user-tz-vs-ET offset on shift_date - 1 vs shift_date + 1.
 * - "aligned" → wall clock unchanged (US-DST-aligned timezones)
 * - "earlier" → notifications appear 1 hour earlier on user's clock (typical for
 *   non-DST tzs on spring forward, or tzs whose own DST ends near US fall back)
 * - "later" → notifications appear 1 hour later on user's clock (typical for
 *   non-DST tzs on fall back)
 */
export function getDstImpactForUser(
    timezone: string,
    shift: { shiftDate: DateTime; kind: "spring" | "fall" },
): DstImpact {
    const dayBefore = shift.shiftDate.minus({ days: 1 }).set({ hour: 12 });
    const dayAfter = shift.shiftDate.plus({ days: 1 }).set({ hour: 12 });

    const userOffsetBefore = dayBefore.setZone(timezone).offset;
    const userOffsetAfter = dayAfter.setZone(timezone).offset;
    const etOffsetBefore = dayBefore.setZone("America/New_York").offset;
    const etOffsetAfter = dayAfter.setZone("America/New_York").offset;

    // Δwall_clock = -Δet_offset + Δuser_offset (in minutes)
    const deltaWallClock =
        -(etOffsetAfter - etOffsetBefore) + (userOffsetAfter - userOffsetBefore);

    if (deltaWallClock === 0) return "aligned";
    if (deltaWallClock < 0) return "earlier";
    return "later";
}
```

Pure Luxon math. Tested against fixture timezones: ET, PT, MT, CT (all aligned), HI, AZ, Tokyo, London, Sydney (drift cases).

### `src/lib/dst-notifications/content.ts`

Renders 4 templates each for email and SMS — keyed on `(kind, impact === "aligned")`. The drift wording uses "earlier" for spring and "later" for fall, derived from `kind` (so the function takes `(kind, impact)` and internally picks the right adverb).

```ts
export interface DstEmailContent {
    subject: string;
    text: string;
    html: string;
}

export function renderDstEmail(args: {
    kind: "spring" | "fall";
    impact: DstImpact;
    shiftDate: DateTime;
    user: UserForRender;
}): DstEmailContent {
    // ... reuses src/lib/messaging/email/layout.ts shell + the bodies below
}

export function renderDstSms(args: {
    kind: "spring" | "fall";
    impact: DstImpact;
}): string {
    // ... returns the SMS strings below
}
```

#### Email subject

- Spring: `"Heads up: US daylight saving time starts Sunday"`
- Fall: `"Heads up: US daylight saving time ends Sunday"`

#### Email body — aligned, spring

> This Sunday, March 8, US daylight saving time begins.
>
> Your timezone follows the same DST schedule as US Eastern Time, so your alert delivery times stay the same — no action needed.

#### Email body — aligned, fall

> This Sunday, November 1, US daylight saving time ends.
>
> Your timezone follows the same DST schedule as US Eastern Time, so your alert delivery times stay the same — no action needed.

#### Email body — drift, spring

> This Sunday, March 8, US daylight saving time begins.
>
> Your timezone doesn't observe US DST, so US-market times — including your scheduled alerts — will appear **1 hour earlier on your local clock** starting Monday. (US markets still open at 9:30 AM ET; only your local clock relative to ET is shifting.)
>
> No action needed unless you'd like to adjust your scheduled times.

#### Email body — drift, fall

> This Sunday, November 1, US daylight saving time ends.
>
> Your timezone doesn't observe US DST, so US-market times — including your scheduled alerts — will appear **1 hour later on your local clock** starting Monday. (US markets still open at 9:30 AM ET; only your local clock relative to ET is shifting.)
>
> No action needed unless you'd like to adjust your scheduled times.

The literal calendar date in each template is computed at render time via `shiftDate.toFormat("MMMM d")` — the example dates above (`March 8`, `November 1`) are the actual 2026 shift dates.

#### SMS — aligned, spring

> DST starts this Sunday — no change to your StockTextAlerts delivery times.

(~80 chars, 2 UCS-2 segments)

#### SMS — aligned, fall

> DST ends this Sunday — no change to your StockTextAlerts delivery times.

#### SMS — drift, spring

> DST starts this Sunday. Your StockTextAlerts will arrive 1 hour earlier on your local clock starting Monday.

(~115 chars, 2 UCS-2 segments)

#### SMS — drift, fall

> DST ends this Sunday. Your StockTextAlerts will arrive 1 hour later on your local clock starting Monday.

### `src/lib/dst-notifications/process.ts`

```ts
export interface DstNotificationsTotals {
    eligibleUsers: number;
    emailsSent: number;
    emailsFailed: number;
    smsSent: number;
    smsFailed: number;
    skippedAlreadyMarked: number;
}

export async function runDstNotifications(options: {
    supabase: SupabaseAdminClient;
    logger: Logger;
    sendEmail: ReturnType<typeof createEmailSender>;
    getSmsSender: ReturnType<typeof createSmsSenderProvider>;
    shiftDate: DateTime;
    kind: "spring" | "fall";
}): Promise<DstNotificationsTotals> {
    // 1. Query eligible users (not already marked for this shift).
    // 2. Batch with Promise.allSettled. Per user:
    //    a. impact = getDstImpactForUser(user.timezone, { shiftDate, kind })
    //    b. If email_notifications_enabled: render + send email
    //    c. If isSmsChannelUsable(user): render + send SMS
    //    d. On any successful delivery, UPDATE users SET dst_notice_sent_for_date = $shiftDate.
    //    e. On total failure (both channels failed), leave column null. Log error.
    // 3. Return totals.
}
```

`Promise.allSettled` per batch (size 25, matching `DAILY_DISPATCH_BATCH_SIZE`). Per-user errors logged at `error` (so the ErrorLogAlarm fires) and don't block other users in the batch.

If both channels are configured for a user but only one succeeds, mark the user as sent — the column tracks "we got something through," not "every channel succeeded."

## Lambda handler

`src/handlers/dst-notifications.ts`:

```ts
import type { Context, ScheduledEvent } from "aws-lambda";
import { DateTime } from "luxon";
import { createSupabaseAdminClient } from "../lib/db/supabase";
import { createLogger } from "../lib/logging";
import { createEmailSender } from "../lib/messaging/email/utils";
import { createSmsSenderProvider } from "../lib/schedule/sms-sender";
import { getNextUsDstShift } from "../lib/dst-notifications/dst-dates";
import { runDstNotifications } from "../lib/dst-notifications/process";

interface ManualForcePayload {
    force: true;
    shiftDate: string; // ISO date, e.g. "2026-03-08"
    kind: "spring" | "fall";
}

function isManualForcePayload(event: unknown): event is ManualForcePayload {
    if (typeof event !== "object" || event === null) return false;
    const e = event as Record<string, unknown>;
    return (
        e.force === true &&
        typeof e.shiftDate === "string" &&
        (e.kind === "spring" || e.kind === "fall")
    );
}

export async function handler(
    event: ScheduledEvent | ManualForcePayload,
    _context: Context,
): Promise<void> {
    const logger = createLogger({ source: "lambda", function: "dst-notifications" });
    const supabase = createSupabaseAdminClient();
    const sendEmail = createEmailSender();
    const getSmsSender = createSmsSenderProvider();

    if (isManualForcePayload(event)) {
        logger.warn("DST notifications force-invoked via payload", {
            shiftDate: event.shiftDate,
            kind: event.kind,
        });
        const shiftDate = DateTime.fromISO(event.shiftDate, { zone: "America/New_York" });
        const totals = await runDstNotifications({
            supabase, logger, sendEmail, getSmsSender,
            shiftDate, kind: event.kind,
        });
        logger.info("DST notifications complete (forced)", { ...totals });
        return;
    }

    // Production cron path
    const now = DateTime.utc();
    const nextShift = getNextUsDstShift(now);
    const expectedFireDate = nextShift.shiftDate.minus({ days: 7 }).toISODate();
    const todayEt = now.setZone("America/New_York").toISODate();

    if (todayEt !== expectedFireDate) {
        logger.info("DST cron fired on unexpected day; refusing to send", {
            todayEt, expectedFireDate, nextShiftDate: nextShift.shiftDate.toISODate(),
        });
        return;
    }

    try {
        const totals = await runDstNotifications({
            supabase, logger, sendEmail, getSmsSender,
            shiftDate: nextShift.shiftDate, kind: nextShift.kind,
        });
        logger.info("DST notifications complete", {
            shiftDate: nextShift.shiftDate.toISODate(), kind: nextShift.kind, ...totals,
        });
    } catch (error) {
        logger.error("DST notifications failed", { action: "dst_notifications_error" }, error);
        throw error;
    }
}
```

The manual force path skips the date check, trusts the payload, and logs at `warn`. Production cron is unaffected.

Manual smoke test:

```bash
aws lambda invoke --function-name stocktextalerts-dst-notifications \
  --payload '{"force":true,"shiftDate":"2026-03-08","kind":"spring"}' \
  --cli-binary-format raw-in-base64-out \
  --profile prod-admin /tmp/dst.json
```

## SAM template additions

In `aws/template.yaml`:

```yaml
DstNotificationsFunction:
  Type: AWS::Serverless::Function
  Metadata:
    BuildMethod: esbuild
    BuildProperties:
      Minify: false
      Format: cjs
      Target: node24
      Sourcemap: true
      EntryPoints:
        - dst-notifications.ts
  Properties:
    FunctionName: stocktextalerts-dst-notifications
    Handler: dst-notifications.handler
    CodeUri: src/handlers
    Timeout: 300
    MemorySize: 256
    LoggingConfig:
      LogGroup: !Ref DstNotificationsLogGroup
    Policies:
      - Version: "2012-10-17"
        Statement:
          - Effect: Allow
            Action:
              - ses:SendEmail
              - ses:SendRawEmail
            Resource: "arn:aws:ses:us-east-1:730335616323:identity/stocktextalerts.com"
    Environment:
      Variables:
        SITE_URL: !Ref SiteUrl
        EMAIL_FROM: !Ref EmailFrom
        UNSUBSCRIBE_TOKEN_SECRET: !Ref UnsubscribeTokenSecret
        TWILIO_ACCOUNT_SID: !Ref TwilioAccountSid
        TWILIO_AUTH_TOKEN: !Ref TwilioAuthToken
        TWILIO_PHONE_NUMBER: !Ref TwilioPhoneNumber
    Events:
      WeekBeforeSpringForward:
        Type: ScheduleV2
        Properties:
          ScheduleExpression: "cron(0 12 ? 3 1#1 *)"
          State: ENABLED
          RoleArn: !GetAtt StockTextAlertsSchedulerRole.Arn
      WeekBeforeFallBack:
        Type: ScheduleV2
        Properties:
          ScheduleExpression: "cron(0 12 ? 10 1L *)"
          State: ENABLED
          RoleArn: !GetAtt StockTextAlertsSchedulerRole.Arn
```

Add the new function ARN to `StockTextAlertsSchedulerRole`'s `lambda:InvokeFunction` resource list:

```yaml
Resource:
  - !Sub arn:aws:lambda:${AWS::Region}:${AWS::AccountId}:function:stocktextalerts-schedule
  - !Sub arn:aws:lambda:${AWS::Region}:${AWS::AccountId}:function:stocktextalerts-asset-events
  - !Sub arn:aws:lambda:${AWS::Region}:${AWS::AccountId}:function:stocktextalerts-compute-daily-stats
  - !Sub arn:aws:lambda:${AWS::Region}:${AWS::AccountId}:function:stocktextalerts-dst-notifications
```

Add `DstNotificationsLogGroup`, `DstNotificationsFunctionErrorAlarm` (Lambda Errors), and `DstNotificationsErrorLogAlarm` (MetricFilter on `$.level = "error"`) following the same pattern as the other three Lambdas (one alarm block per Lambda for the `stocktextalerts/ErrorLogCount` metric, since `chore(alarms)` split this per-Lambda).

## Testing plan

### Pure function tests — `tests/lib/dst-notifications/dst-dates.test.ts`

Scenario-framed:

- "In early March, the next US DST shift is the upcoming 2nd Sunday of March"
- "In late March, the next US DST shift is the 1st Sunday of November"
- "In late October, the next US DST shift is the upcoming 1st Sunday of November"
- "Computed shift dates for 2026–2030 match the published US DST calendar" (table-driven against fixture dates)

### Pure function tests — `tests/lib/dst-notifications/tz-impact.test.ts`

- "A user in America/New_York is classified as aligned for both shifts"
- "A user in America/Los_Angeles is classified as aligned for both shifts"
- "A user in America/Chicago is classified as aligned for both shifts"
- "A user in America/Denver is classified as aligned for both shifts"
- "A user in Pacific/Honolulu is classified as earlier on spring forward and later on fall back"
- "A user in America/Phoenix is classified as earlier on spring forward and later on fall back"
- "A user in Asia/Tokyo is classified as earlier on spring forward and later on fall back"
- "A user in Europe/London is classified as earlier on US spring forward — UK DST hasn't started yet that week"
- "A user in Australia/Sydney is classified as earlier on US spring forward — Sydney is still on AEDT"

### Content tests — `tests/lib/dst-notifications/content.test.ts`

- "Spring aligned email body includes 'no action needed' and the calendar date"
- "Spring drift email body explicitly says '1 hour earlier' and references US Eastern Time"
- "Fall drift SMS fits in 2 UCS-2 segments and contains the word 'later'"
- "Fall aligned SMS contains 'no change' and does not contain 'earlier' or 'later'"
- "Aligned SMS for both kinds does not contain the words 'earlier' or 'later'" (regression guard)

### Integration tests — `tests/lib/dst-notifications/process.test.ts`

Real Supabase, seeded users via `tests/helpers/test-user.ts`:

- "A user in Honolulu with email enabled receives the personalized 'arrives 1 hour earlier' email and dst_notice_sent_for_date is set to the shift date"
- "A user in California with both channels enabled receives the aligned email and SMS"
- "A user with email_notifications_enabled false and SMS unverified receives nothing and is skipped by the eligibility query"
- "A user already marked for this shift date is skipped on a re-run" (call `runDstNotifications` twice; second call's totals show zero new sends)
- "A user with sms_opted_out true receives only email even if SMS is otherwise enabled"
- "A failure to send to one user does not block delivery to other users in the batch" (mock the email sender to fail for one user, succeed for the rest; assert the others have their column set, the failed user does not)
- "A user with email succeeds and SMS fails has dst_notice_sent_for_date marked anyway"

### Handler test — `tests/handlers/dst-notifications.test.ts`

- "Handler invoked exactly 7 days before the upcoming spring shift fans out and returns success counts"
- "Handler invoked on a non-shift day logs at info and returns without sending"
- "Handler invoked with a manual force payload bypasses the date check and uses the supplied shiftDate and kind"
- "Handler logs an error and rethrows when the eligibility query fails" (so the FunctionErrorAlarm fires; uses `expectConsoleError`)

### Schema version

`tests/setup.ts` already asserts `EXPECTED_DB_SCHEMA_VERSION` matches `app_metadata.schema_version`. Bumping the constant in `tests/helpers/constants.ts` is the only test-side change needed; the existing assertion catches drift.

### Explicitly NOT tested

- Live SES/Twilio sends. The existing senders are covered by their own test suites.
- EventBridge cron firing. A typo'd cron simply wouldn't fire — caught by the absence of the once-a-year invocation, not by tests. Verified post-deploy by observing the next March/November invocation in CloudWatch.
- Concurrent invocations. Once-a-year cadence; no realistic concurrency.

## Affected files

### Added

- `src/lib/dst-notifications/dst-dates.ts`
- `src/lib/dst-notifications/tz-impact.ts`
- `src/lib/dst-notifications/content.ts`
- `src/lib/dst-notifications/process.ts`
- `src/handlers/dst-notifications.ts`
- `supabase/migrations/<timestamp>_add_dst_notice_sent_for_date.sql`
- `tests/lib/dst-notifications/dst-dates.test.ts`
- `tests/lib/dst-notifications/tz-impact.test.ts`
- `tests/lib/dst-notifications/content.test.ts`
- `tests/lib/dst-notifications/process.test.ts`
- `tests/handlers/dst-notifications.test.ts`

### Modified

- `aws/template.yaml` — new Lambda, log group, two alarms, scheduler-role policy update
- `tests/helpers/constants.ts` — bump `EXPECTED_DB_SCHEMA_VERSION`
- `src/lib/db/generated/database.types.ts` — regenerated by `npm run db:gen-types`

### Unchanged

- `src/handlers/asset-events.ts` — not piggybacked
- `src/handlers/schedule.ts` — every-minute cron stays focused
- All existing notification flows — DST module is fully additive

## Open questions

1. **Phoenix vs the Navajo Nation.** Most of Arizona doesn't observe DST (`America/Phoenix`), but the Navajo Nation portion uses `America/Denver`. Users self-select a tz from the `timezones` table; whichever they pick, `tz-impact.ts` resolves correctly via Luxon. No special-casing needed.

2. **DST permanently abolished.** If US DST is ever ended legislatively, `getNextUsDstShift(now)` keeps returning future dates (since the algorithm is hardcoded), and the Lambda would still fire and notify users about a non-event. Acceptable risk: this would be a noticeable national news event with months of lead time. Disable the two cron events in `aws/template.yaml` at that point.

3. **First-time deploy.** New column defaults `NULL`. The first cron fire will mark all eligible users for whatever the upcoming shift is. No risk of double-sending across years (the column is per-shift-date, not a generic flag).
