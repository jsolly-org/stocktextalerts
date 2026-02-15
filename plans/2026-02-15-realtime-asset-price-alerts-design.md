# Realtime Asset Price Alerts - Conversation Handoff (2026-02-15)

## Context
User reported that LDOS dropped by about $20 in one day and expected Realtime Asset Price Alerts to catch this. They asked why it was missed and how to make behavior less surprising, especially for users who are capable traders but do not want full-time monitoring noise.

## Key Findings From Review
1. Current alerting is anomaly-score based, not deterministic price-shock based.
2. System requires sufficient recent snapshots before scoring (`MIN_SNAPSHOTS = 5`), which can miss early-session/open shocks.
3. Snapshots are retained only for a short rolling window (60 minutes).
4. Alerts run only during market-open checks.
5. Cooldown is per user+symbol only (not direction/severity aware).
6. UI copy promises “immediate significant movement” but backend behavior is stricter and more conditional.

## Product Direction Agreed In Conversation
1. Keep defaults simple and opinionated.
2. Prioritize “few alerts, high actionability” for part-time-but-serious users.
3. Move toward a 2-layer model:
   - Shock Alerts (deterministic): trigger on large move by `% OR $` thresholds.
   - Context Alerts (scored): anomaly/news/earnings enrichment, not primary blocker.
4. Replace style presets with intent-based onboarding questions (broad, non-technical language).
5. Keep settings revisit simple: “Retune alerts” (no advanced noise controls in v1).

## Validated Product Decisions (2026-02-15)
1. **Shock baseline:** previous close.
2. **Threshold model:** `% OR $` deterministic trigger.
3. **Threshold setup:** onboarding intent quiz (3 broad questions), with “Retune alerts”
   available in settings.
4. **Realtime behavior:** send shock alert immediately; context (news/earnings/anomaly)
   is enrichment-only and never blocks send.
5. **Frequency cap (v1):** max **1 alert event per symbol per trading day**
   (delivered through any enabled channel(s)).
6. **Audience fit:** optimized for casual/part-time traders who want important moves,
   low noise, and predictable alert behavior.
7. **Cap reset boundary:** reset eligibility at market close (not user-local midnight).
8. **Calibration scope (v1):** one global threshold profile across assets.
9. **Setup prerequisite:** disable all notification options unless user has at least one
   tracked asset; show setup notice linking to Watchlist.

## Proposed Onboarding Workflow (v1)
1. **Entry gate**
   - If no tracked assets: block onboarding and show
     `Add at least one tracked stock in Watchlist to set up realtime alerts.`
   - If tracked assets exist: show `Set up realtime price alerts`.
2. **Intro**
   - `Answer 3 quick questions. We’ll tune alerts for important moves with low noise.`
   - `You’ll get at most 1 alert per symbol per trading day.`
3. **Question 1 — risk priority**
   - Prompt: `Which moves matter more to you?`
   - Options: big drops / big gains / both equally
4. **Question 2 — market context**
   - Prompt: `If most stocks are moving together, when should we still text you?`
   - Options: only if this stock stands out / any big move / only very extreme moves
5. **Question 3 — move size strictness**
   - Prompt: `How big should a one-day move usually be before it deserves an alert?`
   - Options: very large only / large / moderate but meaningful
   - Helper text should use tracked-stock examples with concrete anchors for each option (for example `~3% / $5`, `~5% / $10`, `~8% / $20`), calibrated to the user’s watchlist when available.
6. **Example personalization logic (v1)**
   - Prefer tracked-symbol examples when the watchlist is representative for the scenario.
   - If watchlist is concentrated in one profile (e.g., mostly small-cap/high-volatility),
     include one neutral demo large-cap symbol to demonstrate how answer choices differ.
   - If watchlist already spans mixed profiles (e.g., large + small cap), use only tracked symbols.
   - Demo symbols are onboarding-only examples used to make question answers concrete.
   - Keep demo symbols out of alert evaluation.
7. **Mapping (internal)**
   - Derive global `%` and `$` thresholds (`OR`).
   - Derive direction preference and market-relative strictness.
   - Keep hard cap: 1 alert per symbol per trading day, reset at market close.
8. **Confirmation**
   - Show final trigger summary:
     - `Alert when move >= <percent>% OR >= $<dollar> from previous close`
     - `Max 1 alert per symbol per trading day`
   - Show watchlist-specific examples (or mixed with demo symbols when needed):
     - `Would alert:` 2-3 concrete tracked-symbol scenarios crossing threshold
     - `Would not alert:` 2-3 concrete tracked-symbol scenarios below threshold
   - Include one plain-language line explaining why each example does or does not trigger.
   - Actions: `Looks good` and `Retune answers`.

## Bug Confirmed and Fixed During This Session
Issue reference: GitHub `#122` (older `instant_*` naming; mapped to current `market_asset_price_alerts_*`).

### Root cause
Realtime price-alert SMS path did not enforce shared SMS eligibility guard (`shouldSendSms`), so opted-out/unverified/SMS-disabled users could be attempted.

### Fix implemented
1. Added required fields to `PriceAlertUser` query:
   - `phone_verified`
   - `sms_notifications_enabled`
   - `sms_opted_out`
2. Added guard in delivery path:
   - `shouldSendSms(user)` required before any price-alert SMS send attempt.
3. Added regression tests:
   - opted-out user: no SMS attempt
   - sms disabled user: no SMS attempt
   - phone unverified user: no SMS attempt

### Files changed
- `src/lib/market-notifications/users.ts`
- `src/lib/market-notifications/delivery.ts`
- `tests/lib/market-notifications/delivery.test.ts`

### Verification run
- `npm test -- tests/lib/market-notifications/delivery.test.ts` (passed)
- `npm run check:ts` (passed)
- `npm run check:biome` (passed)

## Proposed Next Implementation Plan (Realtime Redesign)
1. Add deterministic Shock Alert evaluator:
   - Trigger on `% OR $` move from previous close.
   - Use thresholds derived from onboarding intent answers.
2. Keep anomaly score pipeline for Context Alerts/enrichment only.
3. Replace cooldown complexity with hard cap:
   - at most 1 realtime alert per symbol per trading day.
4. Update dashboard copy and controls:
   - Remove style/sensitivity framing.
   - Add onboarding intent flow + confirmation summary + “Retune alerts”.
5. Add tests for:
   - large move captured even without news/earnings
   - open-shock behavior
   - one-alert-per-symbol-per-day suppression
   - next-trading-day re-eligibility

## Open Product Decisions For Next Session
1. Final answer-to-threshold mapping matrix for the 3 onboarding questions
   (including direction preference and market-relative strictness defaults).
