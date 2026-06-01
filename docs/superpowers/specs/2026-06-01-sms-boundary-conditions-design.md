# Daily Digest SMS boundary conditions

**Status:** Approved

**Date:** 2026-06-01

## Summary

Daily Digest SMS formatting should respect user-visible boundaries before it
respects raw character limits. Long digests should be split by the application
into ordered SMS bodies so links, footer text, and digest subcategories such as
Earnings, Dividends, and Analyst Consensus are not separated awkwardly across
texts.

The immediate production failure is a Daily Digest where the `📊 Analyst
Consensus` heading and `LDOS:` label appeared at the end of one text, while the
analyst counts for LDOS and the rest of the section appeared in the next text.
That is hard to read and makes the section look broken even though the content
was present.

## Problem

`formatDailyDigestSmsMessage` currently builds a flat array of strings, joins
them with blank lines, then calls `padUrlsToSegmentBoundaries`. That helper
protects URLs from low-level SMS segment boundaries, but the Daily Digest does
not have an application-level chunking model. When the final body is long, the
carrier or SMS client decides where the visible "Text 1" / "Text 2" boundary
falls.

That means the app protects links, but not digest sections. A section heading,
the first ticker label, and the first ticker's data can be split apart.

## Goals

- Keep links intact.
- Keep digest subcategories intact across application-controlled text messages.
- Preserve the existing Daily Digest section order.
- Keep the final manage-notifications URL and STOP footer together.
- Keep the formatter deterministic and testable without sending SMS.
- Avoid truncating Daily Digest content as the primary fix.

## Non-goals

- Do not redesign scheduled price notification SMS in this project. The first
  implementation should focus on Daily Digest.
- Do not remove existing URL segment padding. It remains useful inside each
  final SMS body.
- Do not add durable per-part retry storage in the first implementation.
- Do not introduce a new user preference or feature flag.

## Decisions

- **Boundary scope:** use both application-controlled Daily Digest chunks and
  low-level URL/segment padding.
- **Formatter shape:** build ordered blocks first, then pack blocks into SMS
  bodies.
- **Footer:** include the manage-notifications URL and STOP language together
  on the final SMS body.
- **Delivery success:** the Daily Digest SMS delivery succeeds only when every
  part sends successfully.
- **Partial failure:** if a later part fails after an earlier part was sent, the
  delivery should follow the existing failure path so schedule advancement stays
  conservative. Without durable part-level retry state, a later retry may
  resend earlier parts. That rare duplicate risk is acceptable for the first
  implementation and should be logged clearly.

## Message model

The Daily Digest SMS formatter should build an ordered list of blocks before it
builds strings. Each block has:

- `id`: a stable identifier such as `header`, `assets`, `earnings`,
  `dividends`, `analystConsensus`, or `footer`.
- `text`: the rendered SMS text for that block.
- `boundary`: how the block may be packed.

Most blocks are `atomic`: if the block does not fit in the current SMS body, the
whole block moves to the next body. The initial atomic blocks should include:

- Header and delay banner.
- Market-closed disclaimer.
- Top Movers.
- News and Rumors if supplied to the formatter.
- Earnings.
- Dividends.
- Splits.
- Upcoming IPOs.
- Analyst Consensus.
- Insider Trades.
- Footer.

`Your Assets` is the only block that should initially allow child-level
splitting, because large portfolios can exceed a single SMS body by themselves.
Its safe split boundary is between asset entries, never inside one asset line.

If future data shows another section can exceed a full SMS body on its own, that
section should declare explicit child boundaries rather than falling back to
arbitrary character splitting.

## Chunking rules

The Daily Digest formatter should expose `formatDailyDigestSmsMessages`, which
returns the ordered SMS bodies to send. The existing singular formatter should
be replaced in Daily Digest delivery rather than treated as the source of truth.

Packing rules:

1. Drop empty blocks before packing.
2. Preserve the existing section order.
3. Use a `1500` character per-body budget, below Twilio's 1600-character hard
   body limit, to leave room for URL padding.
4. Add blocks to the current body until the next atomic block would exceed the
   budget.
5. Move an overflowing atomic block to the next body.
6. Split a splittable block only at declared child boundaries.
7. After each final body is assembled, run the existing URL padding logic on
   that body.

The formatter should not add "Part 1/2" labels in the first implementation. The
texts already arrive in order, and avoiding part labels keeps the character
budget focused on user content.

## Delivery flow

`processDailyDigestSmsDelivery` should send the formatted bodies sequentially.
The delivery path should log enough metadata to debug multipart behavior:

- Total part count.
- Current part number on failure.
- Character length for each part.
- The existing provider error code and message when a send fails.

The notification log should store one row for the Daily Digest SMS attempt. For
multi-part messages, the logged message should join parts with clear separators
such as `--- SMS part 1/2 ---` so support/debugging can see what content was
attempted and which part failed without adding schema or row-count churn.

If all parts send, the delivery result is successful and the existing schedule
advance behavior continues. If any part fails, the delivery result is failed.

## Data flow

```text
Daily Digest data
  -> render ordered SMS blocks
  -> pack blocks into SMS bodies
  -> pad URLs inside each body
  -> send bodies sequentially
  -> record success only when all sends succeed
```

## Acceptance criteria

- A Daily Digest shaped like the reported John Solly example does not split the
  `📊 Analyst Consensus` heading, the `LDOS:` label, and the LDOS analyst counts
  across different texts. If the section does not fit at the end of one text,
  the whole section starts in the next text.
- Earnings, Dividends, Splits, Upcoming IPOs, Analyst Consensus, and Insider
  Trades are each treated as complete subcategory blocks.
- The manage-notifications URL and `Reply STOP to opt out.` remain together on
  the final text.
- URLs still receive existing segment-boundary padding inside each generated
  SMS body.
- A large `Your Assets` block may split across texts, but only between asset
  entries.
- No Daily Digest content is truncated solely to satisfy the chunking rules.
- A failed send for any part returns a failed Daily Digest SMS delivery result.

## Testing

Add scenario-based tests around the Daily Digest formatter and delivery path:

1. **Reported Analyst Consensus boundary:** construct a digest where the assets,
   earnings, and dividends nearly fill the first SMS body. Assert that Analyst
   Consensus moves entirely to the next body, including the first ticker's
   counts.
2. **Footer atomicity:** assert the manage URL and STOP language appear together
   in the final body.
3. **URL protection:** assert final bodies still apply URL segment padding and
   do not regress `padUrlsToSegmentBoundaries`.
4. **Splittable assets:** construct enough assets to exceed one body and assert
   the split happens between asset entries, not inside an entry.
5. **Delivery success:** when all parts send, the Daily Digest SMS delivery is
   recorded as successful.
6. **Delivery failure:** when a later part fails, the delivery result is failed
   and the failure log identifies the failed part.

Existing unit tests that expect one SMS string should move to the plural
formatter where they are testing Daily Digest behavior. Tests that only care
about contained text can use `messages.join("\n\n")` locally.

## Open questions

None. The brainstorming session resolved the boundary scope, footer placement,
success policy, and testing expectations.
