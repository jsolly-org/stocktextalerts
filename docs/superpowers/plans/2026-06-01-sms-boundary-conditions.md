# Daily Digest SMS Boundary Conditions Implementation Plan

**Spec:** `docs/superpowers/specs/2026-06-01-sms-boundary-conditions-design.md`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split long Daily Digest SMS output into app-controlled message bodies that keep links, footer text, and digest subcategories intact.

**Architecture:** Add a focused SMS block-packing helper that packs ordered atomic and splittable blocks into 1500-character bodies. Refactor Daily Digest SMS formatting to build blocks, pack them, and apply URL segment padding per body. Update delivery to send bodies sequentially and record one notification-log row for the multipart attempt.

**Tech Stack:** TypeScript, Vitest, Astro/Vite test environment, existing Supabase admin-client mocks, existing SMS formatting helpers.

---

## File Structure

- Create `src/lib/messaging/sms/block-packing.ts`: generic SMS block model and packing algorithm. It knows about character budgets and safe child boundaries, but not Daily Digest content.
- Modify `src/lib/daily-digest/delivery.ts`: build Daily Digest SMS blocks, expose `formatDailyDigestSmsMessages`, keep `formatDailyDigestSmsMessage` as a wrapper for compatibility, and send multipart Daily Digest SMS sequentially.
- Modify `tests/lib/daily-digest-delivery.test.ts`: add formatter and direct delivery tests for section boundaries, footer atomicity, URL padding, asset splitting, success, and failure.
- Create `tests/lib/messaging/sms/block-packing.test.ts`: unit-test the helper independently so the Daily Digest tests can stay scenario-focused.

## Task 1: SMS Block Packing Helper

**Files:**

- Create: `src/lib/messaging/sms/block-packing.ts`
- Test: `tests/lib/messaging/sms/block-packing.test.ts`

- [ ] **Step 1: Write failing tests for atomic and splittable packing**

Create `tests/lib/messaging/sms/block-packing.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { packSmsBlocks, SMS_BODY_CHAR_BUDGET } from "../../../../src/lib/messaging/sms/block-packing";

describe("packSmsBlocks", () => {
  it("moves an atomic block to the next SMS body when it would exceed the budget", () => {
    const first = "A".repeat(SMS_BODY_CHAR_BUDGET - 20);
    const second = "📊 Analyst Consensus\nLDOS: 8 Buy, 11 Hold, 0 Sell";

    const messages = packSmsBlocks([
      { id: "assets", boundary: "atomic", text: first },
      { id: "analystConsensus", boundary: "atomic", text: second },
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toBe(first);
    expect(messages[1]).toBe(second);
  });

  it("splits a splittable block only between child entries and repeats the header", () => {
    const child = "AAPL — $187.42 (+1.23%) past 7 days: ▁▂▃▅▇";
    const messages = packSmsBlocks(
      [
        {
          id: "assets",
          boundary: "split-between-children",
          header: "💰 Your Assets",
          children: Array.from({ length: 5 }, (_, index) => `${child} ${index + 1}`),
          childSeparator: "\n\n",
        },
      ],
      160,
    );

    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) {
      expect(message).toMatch(/^💰 Your Assets\n/);
      expect(message).not.toContain("AAPL — $187.42 (+1.23%) past 7 days: ▁▂\n\n▃");
    }
  });

  it("drops empty atomic and splittable blocks before packing", () => {
    const messages = packSmsBlocks([
      { id: "empty-atomic", boundary: "atomic", text: "   " },
      {
        id: "empty-splittable",
        boundary: "split-between-children",
        header: "💰 Your Assets",
        children: ["", "  "],
      },
      { id: "footer", boundary: "atomic", text: "Reply STOP to opt out." },
    ]);

    expect(messages).toEqual(["Reply STOP to opt out."]);
  });

  it("keeps an oversized atomic block whole rather than splitting arbitrary text", () => {
    const text = `📊 Analyst Consensus\n${"LDOS: 8 Buy, 11 Hold, 0 Sell\n".repeat(80)}`;

    const messages = packSmsBlocks([{ id: "analystConsensus", boundary: "atomic", text }], 100);

    expect(messages).toEqual([text.trim()]);
  });
});
```

- [ ] **Step 2: Run the helper tests and verify they fail**

Run:

```bash
npm test -- tests/lib/messaging/sms/block-packing.test.ts
```

Expected: FAIL because `src/lib/messaging/sms/block-packing.ts` does not exist.

- [ ] **Step 3: Implement the packing helper**

Create `src/lib/messaging/sms/block-packing.ts`:

```ts
export const SMS_BODY_CHAR_BUDGET = 1500;

const BLOCK_SEPARATOR = "\n\n";

export type AtomicSmsBlock = {
  id: string;
  boundary: "atomic";
  text: string | null | undefined;
};

export type SplittableSmsBlock = {
  id: string;
  boundary: "split-between-children";
  header: string;
  children: Array<string | null | undefined>;
  childSeparator?: string;
};

export type SmsBlock = AtomicSmsBlock | SplittableSmsBlock;

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function appendBlock(body: string, blockText: string): string {
  return body ? `${body}${BLOCK_SEPARATOR}${blockText}` : blockText;
}

function fitsInBody(body: string, blockText: string, maxChars: number): boolean {
  return appendBlock(body, blockText).length <= maxChars;
}

function renderSplittableBlock(block: SplittableSmsBlock, children: string[]): string {
  return `${block.header}\n${children.join(block.childSeparator ?? "\n")}`.trim();
}

function pushCurrent(messages: string[], current: string): string {
  const normalized = current.trim();
  if (normalized) {
    messages.push(normalized);
  }
  return "";
}

function packAtomicBlock(
  messages: string[],
  current: string,
  text: string,
  maxChars: number,
): string {
  if (fitsInBody(current, text, maxChars)) {
    return appendBlock(current, text);
  }
  current = pushCurrent(messages, current);
  return text;
}

function packSplittableBlock(
  messages: string[],
  current: string,
  block: SplittableSmsBlock,
  maxChars: number,
): string {
  const children = block.children.map(normalizeText).filter(Boolean);
  let index = 0;

  while (index < children.length) {
    let chunk: string[] = [];
    while (index < children.length) {
      const candidateChunk = [...chunk, children[index]];
      const candidateText = renderSplittableBlock(block, candidateChunk);
      if (fitsInBody(current, candidateText, maxChars)) {
        chunk = candidateChunk;
        index++;
        continue;
      }
      if (chunk.length === 0 && current) {
        current = pushCurrent(messages, current);
        continue;
      }
      if (chunk.length === 0) {
        chunk = [children[index]];
        index++;
      }
      break;
    }

    if (chunk.length > 0) {
      current = appendBlock(current, renderSplittableBlock(block, chunk));
    }
    if (index < children.length) {
      current = pushCurrent(messages, current);
    }
  }

  return current;
}

export function packSmsBlocks(
  blocks: SmsBlock[],
  maxChars = SMS_BODY_CHAR_BUDGET,
): string[] {
  const messages: string[] = [];
  let current = "";

  for (const block of blocks) {
    if (block.boundary === "atomic") {
      const text = normalizeText(block.text);
      if (!text) continue;
      current = packAtomicBlock(messages, current, text, maxChars);
    } else {
      current = packSplittableBlock(messages, current, block, maxChars);
    }
  }

  pushCurrent(messages, current);
  return messages;
}
```

- [ ] **Step 4: Run the helper tests and verify they pass**

Run:

```bash
npm test -- tests/lib/messaging/sms/block-packing.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the helper**

Run:

```bash
git add src/lib/messaging/sms/block-packing.ts tests/lib/messaging/sms/block-packing.test.ts
git commit -m "$(cat <<'EOF'
feat(sms): add block packing helper

EOF
)"
```

## Task 2: Daily Digest Formatter Uses Blocks

**Files:**

- Modify: `src/lib/daily-digest/delivery.ts`
- Modify: `tests/lib/daily-digest-delivery.test.ts`

- [ ] **Step 1: Write failing formatter tests for Daily Digest boundaries**

Modify the import in `tests/lib/daily-digest-delivery.test.ts`:

```ts
import {
  formatDailyDigestEmail,
  formatDailyDigestSmsMessage,
  formatDailyDigestSmsMessages,
} from "../../src/lib/daily-digest/delivery";
```

Add these tests near the existing SMS tests:

```ts
it("moves Analyst Consensus to the next SMS body when it would split from the first ticker", () => {
  const userAssets = Array.from({ length: 27 }, (_, index) => ({
    symbol: `AST${index + 1}`,
    name: `Asset ${index + 1}`,
  }));
  const assetPrices: AssetPriceMap = new Map(
    userAssets.map((asset, index) => [
      asset.symbol,
      { price: 100 + index, changePercent: index / 10 },
    ]),
  );

  const messages = formatDailyDigestSmsMessages({
    userAssets,
    assetPrices,
    extras,
    assetEvents: {
      eventsSection: {
        earnings: "SAIC: earnings today (bmo)",
        dividends: "NOC: ex-div today $2.47\nLMT: ex-div today $3.45",
        splits: null,
        ipos: null,
      },
      analystSection:
        "LDOS: 8 Buy, 11 Hold, 0 Sell\nBAH: 1 Buy, 12 Hold, 8 Sell\nCACI: 13 Buy, 5 Hold, 0 Sell",
      insiderSection: null,
      hasAnyContent: true,
    },
  });

  expect(messages.length).toBeGreaterThan(1);
  const analystMessage = messages.find((message) => message.includes("📊 Analyst Consensus"));
  expect(analystMessage).toBeDefined();
  expect(analystMessage).toContain("📊 Analyst Consensus\nLDOS: 8 Buy, 11 Hold, 0 Sell");
  for (const message of messages) {
    if (!message.includes("📊 Analyst Consensus")) {
      expect(message).not.toContain("LDOS: 8 Buy, 11 Hold, 0 Sell");
    }
  }
});

it("keeps the manage URL and STOP footer together on the final SMS body", () => {
  const userAssets = Array.from({ length: 35 }, (_, index) => ({
    symbol: `FOO${index + 1}`,
    name: `Foo ${index + 1}`,
  }));
  const assetPrices: AssetPriceMap = new Map(
    userAssets.map((asset) => [asset.symbol, { price: 42.5, changePercent: 1.25 }]),
  );

  const messages = formatDailyDigestSmsMessages({ userAssets, assetPrices, extras });
  const finalMessage = messages.at(-1) ?? "";

  expect(finalMessage).toContain("Manage your notifications:");
  expect(finalMessage).toContain("Reply STOP to opt out.");
  expect(finalMessage.indexOf("Manage your notifications:")).toBeLessThan(
    finalMessage.indexOf("Reply STOP to opt out."),
  );
  for (const message of messages.slice(0, -1)) {
    expect(message).not.toContain("Reply STOP to opt out.");
  }
});

it("applies URL segment padding to each final Daily Digest SMS body", () => {
  const assetPrices: AssetPriceMap = new Map([["AAPL", { price: 187.42, changePercent: 1.23 }]]);

  const messages = formatDailyDigestSmsMessages({
    userAssets: [userAssets[0]],
    assetPrices,
    extras,
    delayBanner: "A".repeat(1420),
  });

  const finalMessage = messages.at(-1) ?? "";
  const dashboardIndex = finalMessage.indexOf("http://localhost:4321/dashboard");

  expect(dashboardIndex).toBeGreaterThanOrEqual(0);
  expect(dashboardIndex % 67).toBe(0);
});

it("splits oversized Your Assets content only between asset entries", () => {
  const userAssets = Array.from({ length: 60 }, (_, index) => ({
    symbol: `BIG${index + 1}`,
    name: `Big ${index + 1}`,
  }));
  const assetPrices: AssetPriceMap = new Map(
    userAssets.map((asset, index) => [
      asset.symbol,
      { price: 300 + index, changePercent: -0.5 },
    ]),
  );

  const messages = formatDailyDigestSmsMessages({ userAssets, assetPrices, extras });

  expect(messages.length).toBeGreaterThan(1);
  expect(messages.join("\n\n")).toContain("BIG1 — $300.00 (-0.50%)");
  expect(messages.join("\n\n")).toContain("BIG60 — $359.00 (-0.50%)");
  for (const message of messages) {
    expect(message).not.toMatch(/BIG\d+ — \$\d+\.\d{2} \(-0\.50%\)\n\npast/);
  }
});
```

- [ ] **Step 2: Run the Daily Digest formatter tests and verify they fail**

Run:

```bash
npm test -- tests/lib/daily-digest-delivery.test.ts
```

Expected: FAIL because `formatDailyDigestSmsMessages` is not exported and the formatter still returns one body.

- [ ] **Step 3: Implement block-based Daily Digest formatting**

Modify `src/lib/daily-digest/delivery.ts` imports:

```ts
import { packSmsBlocks, type SmsBlock } from "../messaging/sms/block-packing";
```

Add a shared options type above `formatDailyDigestSmsMessage`:

```ts
type DailyDigestSmsFormatOptions = {
  userAssets: UserAssetRow[];
  assetPrices: AssetPriceMap;
  extras: SmsExtras;
  assetEvents?: AssetEventsResult;
  sparklines?: SparklineMap;
  marketOpen?: boolean;
  marketClosureInfo?: MarketClosureInfo | null;
  /** Optional delay banner text (inserted after header when notification is late). */
  delayBanner?: string | null;
};
```

Add a helper to build per-asset lines:

```ts
function buildDailyDigestPriceLines(options: DailyDigestSmsFormatOptions): string[] {
  return options.userAssets.map((asset) => {
    const sparkline = options.sparklines?.get(asset.symbol);
    return formatDailyDigestPriceLine(
      asset,
      options.assetPrices.get(asset.symbol),
      sparkline,
      shouldShowDigestChangePercent(options.marketOpen, sparkline),
    );
  });
}
```

Replace the current SMS formatter with a block builder, plural formatter, and compatibility wrapper:

```ts
function buildDailyDigestSmsBlocks(options: DailyDigestSmsFormatOptions): SmsBlock[] {
  const optOutSuffix = "Reply STOP to opt out.";
  const dashboardUrl = new URL("/dashboard", getSiteUrl()).toString();
  const marketDisclaimer =
    options.marketOpen === false ? buildMarketClosedBannerText(options.marketClosureInfo) : "";
  const ae = options.assetEvents;
  const priceLines = buildDailyDigestPriceLines(options);

  return [
    { id: "header", boundary: "atomic", text: "StockTextAlerts — Your daily digest 🗓️" },
    { id: "delayBanner", boundary: "atomic", text: options.delayBanner },
    { id: "marketDisclaimer", boundary: "atomic", text: marketDisclaimer },
    {
      id: "assets",
      boundary: "split-between-children",
      header: "💰 Your Assets",
      children: priceLines,
      childSeparator: "\n\n",
    },
    { id: "topMovers", boundary: "atomic", text: formatExtrasSection("🚀 Top Movers", options.extras.topMovers) },
    { id: "news", boundary: "atomic", text: formatExtrasSection("🗞️ News", options.extras.news) },
    { id: "rumors", boundary: "atomic", text: formatExtrasSection("🤫 Rumors", options.extras.rumors) },
    { id: "earnings", boundary: "atomic", text: formatExtrasSection("📈 Earnings", ae?.eventsSection?.earnings) },
    { id: "dividends", boundary: "atomic", text: formatExtrasSection("💰 Dividends", ae?.eventsSection?.dividends) },
    { id: "splits", boundary: "atomic", text: formatExtrasSection("✂️ Splits", ae?.eventsSection?.splits) },
    { id: "ipos", boundary: "atomic", text: formatExtrasSection("🆕 Upcoming IPOs", ae?.eventsSection?.ipos) },
    { id: "analystConsensus", boundary: "atomic", text: formatExtrasSection("📊 Analyst Consensus", ae?.analystSection) },
    { id: "insiderTrades", boundary: "atomic", text: formatExtrasSection("🏦 Insider Trades", ae?.insiderSection) },
    {
      id: "footer",
      boundary: "atomic",
      text: `Manage your notifications: ${dashboardUrl}\n\n${optOutSuffix}`,
    },
  ];
}

/** Format the daily digest message bodies for SMS delivery. */
export function formatDailyDigestSmsMessages(options: DailyDigestSmsFormatOptions): string[] {
  return packSmsBlocks(buildDailyDigestSmsBlocks(options)).map((message) =>
    padUrlsToSegmentBoundaries(message),
  );
}

/** Format the daily digest message body for legacy single-string callers. */
export function formatDailyDigestSmsMessage(options: DailyDigestSmsFormatOptions): string {
  return formatDailyDigestSmsMessages(options).join("\n\n");
}
```

Then update `buildDailyDigestPricesSummary` only if needed by the email path. Keep the existing email output unchanged.

- [ ] **Step 4: Run the Daily Digest formatter tests and verify they pass**

Run:

```bash
npm test -- tests/lib/daily-digest-delivery.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run the helper tests again**

Run:

```bash
npm test -- tests/lib/messaging/sms/block-packing.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the formatter change**

Run:

```bash
git add src/lib/daily-digest/delivery.ts tests/lib/daily-digest-delivery.test.ts
git commit -m "$(cat <<'EOF'
feat(daily-digest): split SMS on section boundaries

EOF
)"
```

## Task 3: Multipart Daily Digest SMS Delivery

**Files:**

- Modify: `src/lib/daily-digest/delivery.ts`
- Modify: `tests/lib/daily-digest-delivery.test.ts`

- [ ] **Step 1: Write failing delivery tests for success and later-part failure**

Add a minimal user and stats helper near the top of `tests/lib/daily-digest-delivery.test.ts`:

```ts
function makeSmsUser(): UserRecord {
  return {
    id: "user-sms-1",
    email: "sms@example.com",
    timezone: "America/New_York",
    sms_notifications_enabled: true,
    email_notifications_enabled: false,
    phone_verified: true,
    phone_country_code: "+1",
    phone_number: "5550101",
    sms_opted_out: false,
    daily_digest_include_prices_sms: true,
    daily_digest_include_prices_email: false,
    daily_digest_include_top_movers_sms: false,
    daily_digest_include_top_movers_email: false,
    daily_digest_include_news_email: false,
    daily_digest_include_rumors_email: false,
    market_scheduled_asset_price_include_sms: false,
    asset_events_include_calendar_sms: false,
    asset_events_include_ipo_sms: false,
    asset_events_include_analyst_sms: false,
    asset_events_include_insider_sms: false,
    market_asset_price_alerts_include_sms: false,
    price_move_alerts_include_sms: false,
    price_targets_include_sms: false,
  } as UserRecord;
}

function makeStats() {
  return {
    skipped: 0,
    logFailures: 0,
    emailsSent: 0,
    emailsFailed: 0,
    smsSent: 0,
    smsFailed: 0,
  };
}
```

Add a small Supabase mock that supports the calls used by `claimNotification`, `recordNotification`, and `updateScheduledNotificationRow`:

```ts
function makeDailyDigestSupabaseMock() {
  const notificationLogInserts: unknown[] = [];
  const scheduledUpdates: unknown[] = [];

  const scheduledTable = {
    select: () => ({
      eq: () => ({
        eq: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: { attempt_count: 0 }, error: null }),
              }),
            }),
          }),
        }),
      }),
    }),
    upsert: async () => ({ data: null, error: null }),
    update: (payload: unknown) => {
      scheduledUpdates.push(payload);
      const chain = {
        eq: () => chain,
        then: (resolve: (value: { error: null }) => void) => resolve({ error: null }),
      };
      return chain;
    },
  };

  const notificationLogTable = {
    insert: async (payload: unknown) => {
      notificationLogInserts.push(payload);
      return { error: null };
    },
  };

  return {
    notificationLogInserts,
    scheduledUpdates,
    client: {
      from: (table: string) => {
        if (table === "scheduled_notifications") return scheduledTable;
        if (table === "notification_log") return notificationLogTable;
        throw new Error(`Unexpected table: ${table}`);
      },
    },
  };
}
```

Add tests:

```ts
it("sends multipart Daily Digest SMS bodies in order and records one successful attempt", async () => {
  const userAssets = Array.from({ length: 50 }, (_, index) => ({
    symbol: `ORD${index + 1}`,
    name: `Ordered ${index + 1}`,
  }));
  const assetPrices: AssetPriceMap = new Map(
    userAssets.map((asset) => [asset.symbol, { price: 50, changePercent: 0.25 }]),
  );
  const supabase = makeDailyDigestSupabaseMock();
  const smsSender = vi.fn(async () => ({ success: true }));
  const stats = makeStats();

  await processDailyDigestSmsDelivery({
    user: makeSmsUser(),
    supabase: supabase.client as never,
    logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never,
    scheduledDate: "2026-06-01",
    scheduledMinutes: 18 * 60,
    userAssets,
    assetPrices,
    extras,
    getSmsSender: () => ({ sender: smsSender }),
    stats,
  });

  expect(smsSender.mock.calls.length).toBeGreaterThan(1);
  expect(stats.smsSent).toBe(1);
  expect(stats.smsFailed).toBe(0);
  expect(supabase.notificationLogInserts).toHaveLength(1);
  expect(JSON.stringify(supabase.notificationLogInserts[0])).toContain("--- SMS part 1/");
});

it("marks Daily Digest SMS failed when a later SMS part fails", async () => {
  const userAssets = Array.from({ length: 50 }, (_, index) => ({
    symbol: `FAIL${index + 1}`,
    name: `Failure ${index + 1}`,
  }));
  const assetPrices: AssetPriceMap = new Map(
    userAssets.map((asset) => [asset.symbol, { price: 75, changePercent: 0.5 }]),
  );
  const supabase = makeDailyDigestSupabaseMock();
  const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  const smsSender = vi
    .fn()
    .mockResolvedValueOnce({ success: true })
    .mockResolvedValueOnce({ success: false, error: "Twilio timeout", errorCode: "ETIMEDOUT" });
  const stats = makeStats();

  await processDailyDigestSmsDelivery({
    user: makeSmsUser(),
    supabase: supabase.client as never,
    logger: logger as never,
    scheduledDate: "2026-06-01",
    scheduledMinutes: 18 * 60,
    userAssets,
    assetPrices,
    extras,
    getSmsSender: () => ({ sender: smsSender }),
    stats,
  });

  expect(smsSender).toHaveBeenCalledTimes(2);
  expect(stats.smsSent).toBe(0);
  expect(stats.smsFailed).toBe(1);
  expect(logger.error).toHaveBeenCalledWith(
    "Failed to send Daily Digest SMS part",
    expect.objectContaining({ partNumber: 2, totalParts: expect.any(Number), error: "Twilio timeout" }),
  );
  expect(JSON.stringify(supabase.notificationLogInserts[0])).toContain("SMS part 2/");
  expect(JSON.stringify(supabase.notificationLogInserts[0])).toContain("Twilio timeout");
});
```

- [ ] **Step 2: Run the delivery tests and verify they fail**

Run:

```bash
npm test -- tests/lib/daily-digest-delivery.test.ts
```

Expected: FAIL because `processDailyDigestSmsDelivery` still sends one SMS body.

- [ ] **Step 3: Add multipart delivery helpers**

Modify the existing type import in `src/lib/daily-digest/delivery.ts`:

```ts
import type { DeliveryResult, UserAssetRow, UserRecord } from "../messaging/types";
```

Add helpers near the SMS delivery function:

```ts
function formatDailyDigestSmsLogMessage(messages: string[]): string {
  if (messages.length === 1) return messages[0] ?? "";
  return messages
    .map((message, index) => `--- SMS part ${index + 1}/${messages.length} ---\n${message}`)
    .join("\n\n");
}

function summarizeDailyDigestSmsResults(
  results: DeliveryResult[],
  totalParts: number,
): DeliveryResult {
  const failedIndex = results.findIndex((result) => !result.success);
  if (failedIndex === -1 && results.length === totalParts) {
    return { success: true };
  }

  const failedPartNumber = failedIndex === -1 ? results.length + 1 : failedIndex + 1;
  const failed = results[failedIndex] ?? {
    success: false,
    error: "SMS delivery stopped before all parts were sent",
  };

  return {
    success: false,
    error: `SMS part ${failedPartNumber}/${totalParts} failed: ${failed.error ?? "Unknown error"}`,
    errorCode: failed.errorCode,
  };
}
```

- [ ] **Step 4: Send all Daily Digest SMS parts sequentially**

Replace the single-message block in `processDailyDigestSmsDelivery`:

```ts
const smsMessages = formatDailyDigestSmsMessages({
  userAssets,
  assetPrices,
  extras,
  assetEvents,
  sparklines: options.sparklines,
  marketOpen: options.marketOpen,
  marketClosureInfo: options.marketClosureInfo,
  delayBanner: options.delayBanner,
});
const partResults: DeliveryResult[] = [];

for (const [index, smsMessage] of smsMessages.entries()) {
  const partNumber = index + 1;
  const partResult = await sendUserSms(user, smsMessage, smsSenderResult.sender, supabase);
  partResults.push(partResult);

  if (!partResult.success) {
    logger.error("Failed to send Daily Digest SMS part", {
      userId: user.id,
      scheduledDate,
      scheduledMinutes,
      partNumber,
      totalParts: smsMessages.length,
      partLength: smsMessage.length,
      error: partResult.error,
      errorCode: partResult.errorCode ?? null,
    });
    break;
  }
}

const result = summarizeDailyDigestSmsResults(partResults, smsMessages.length);
const loggedMessage = formatDailyDigestSmsLogMessage(smsMessages);
const logged = await recordNotification(supabase, {
  user_id: user.id,
  type: "daily",
  delivery_method: "sms",
  message_delivered: result.success,
  message: loggedMessage,
  ...deliveryResultToLogFields(result),
});
```

Keep the existing stats and `updateScheduledNotificationRow` logic after this block unchanged so `smsSent` and `smsFailed` continue to count Daily Digest attempts, not individual SMS parts.

- [ ] **Step 5: Run the delivery tests and verify they pass**

Run:

```bash
npm test -- tests/lib/daily-digest-delivery.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run the relevant process regression tests**

Run:

```bash
npm test -- tests/lib/daily-digest/process.test.ts
```

Expected: PASS. Existing process tests should still see one send for small SMS-only digests.

- [ ] **Step 7: Commit the delivery change**

Run:

```bash
git add src/lib/daily-digest/delivery.ts tests/lib/daily-digest-delivery.test.ts
git commit -m "$(cat <<'EOF'
fix(daily-digest): send multipart SMS bodies sequentially

EOF
)"
```

## Task 4: Final Verification

**Files:**

- No planned source changes unless verification exposes a defect.

- [ ] **Step 1: Run focused tests**

Run:

```bash
npm test -- tests/lib/messaging/sms/block-packing.test.ts tests/lib/daily-digest-delivery.test.ts tests/lib/daily-digest/process.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run TypeScript and Biome checks**

Run:

```bash
npm run check:ts
npm run check:biome
```

Expected: PASS. Existing TypeScript hints may be printed by `astro check`, but there should be zero errors.

- [ ] **Step 3: Run the full test suite if Supabase is healthy**

Run:

```bash
npm test
```

Expected: PASS. If the per-repo test lock reports another holder, wait for that run or confirm the holder is stale before retrying.

- [ ] **Step 4: Commit any verification fixes**

If verification required fixes, commit them:

```bash
git add src/lib/messaging/sms/block-packing.ts src/lib/daily-digest/delivery.ts tests/lib/messaging/sms/block-packing.test.ts tests/lib/daily-digest-delivery.test.ts
git commit -m "$(cat <<'EOF'
test(daily-digest): verify SMS boundary behavior

EOF
)"
```

Skip this commit if Task 4 made no code changes.

## Self-Review

- Spec coverage: Task 1 implements deterministic block packing and declared child boundaries. Task 2 implements Daily Digest blocks, 1500-character chunking, URL padding per final body, footer atomicity, and non-truncating asset splitting. Task 3 implements sequential multipart send, one notification-log row, all-parts-required success, and failure logging. Task 4 covers verification.
- Placeholder scan: no `TBD`, `TODO`, "implement later", or undefined future functions remain in the plan.
- Type consistency: `SmsBlock`, `packSmsBlocks`, `formatDailyDigestSmsMessages`, `formatDailyDigestSmsLogMessage`, and `summarizeDailyDigestSmsResults` are introduced before later tasks use them.
