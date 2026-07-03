# Plan: Beautiful Telegram Notifications

**Status:** Phase 1 implemented — 2026-07-03 (same day; see "Phase 1 as
implemented" below). Phase 2 (Satori cards) remains proposed.
**Author:** design session (Claude + John)
**Scope:** Restore chart rendering in the Lambda runtime and upgrade Telegram
notifications from bare candlesticks to designed, branded cards.
**Research:** the deep-research pass (2026-07-03) confirmed the WASM-first
direction and sharpened it — use `@resvg/resvg-wasm`, never resvg's native
napi binding (same native-dependency class as node-canvas), and encode
gain/loss redundantly rather than by red/green hue alone (~8% of men can't
distinguish that pair).

## Background: what was "rolled back"

Telegram support shipped with candlestick charts (commits `78e9a102`,
`c4f9755b`). The charts were **never reverted in code** — they are dormant on
Lambda. The render path is:

1. `parts/charts/candlestick.ts` → `buildCandlestickSvg()` builds a candlestick
   chart as an **SVG string** in pure TypeScript.
2. `renderChartPng()` rasterizes that SVG to a PNG buffer via
   **`@resvg/resvg-js`**.
3. The Telegram sender attaches the PNG with `sendPhoto` (see
   `telegram/price-alert.ts` → `formatPriceAlertTelegram`).

### The constraint

`@resvg/resvg-js` ships a **native, platform-specific `.node` binary** that
esbuild cannot bundle into the Lambda package.

- **2026-06-21 incident:** the `.node` esbuild break aborted a deploy *after*
  `supabase db push` had already migrated prod, leaving prod DB ahead of prod
  code. Fix `13842ea0` reordered the deploy to build-first; fix `228cb5df`
  marked resvg **`External`** in `aws/template.yaml`, lazy-loaded it, and made
  `renderChartPng()` degrade to `null` (text-only) when the binary is absent.
- **The resvg Lambda layer was never shipped.** `aws/template.yaml` says
  verbatim: *"Restore candlestick PNGs by shipping resvg via a Lambda layer in a
  later deploy."*

### Current production state

The notification pipeline runs on **Lambda** (`src/handlers/delivery/schedule.ts`
and the alert handlers). resvg is `External` there and no layer provides it, so
`loadResvg()` returns `null` → **every Telegram message users actually receive is
text-only.** Charts render only locally and on Vercel, where the native binary
resolves — neither of which sends production notifications.

That is the "we tried charts but Lambda didn't support it" the team remembers.

## Options for rasterizing on Lambda

| | Approach | Fixes Lambda | Beautiful | Key risk |
| --- | --- | --- | --- | --- |
| **A** | Ship resvg-js as a **Lambda layer** | ✅ | keeps candlestick | native binary pinned to Lambda arch + Node ABI; re-break on every Node/arch bump |
| **B** | Swap to **`@resvg/resvg-wasm`** (pure WASM) | ✅ | keeps candlestick | one-time `initWasm`; ship the `.wasm` asset in the bundle |
| **C** | Offload to a **render service** (QuickChart / Vercel endpoint) | ✅ | flexible | network dependency in the send hot-path; 3rd-party = user data off-platform |
| **D** | **Satori** (JSX→SVG) + resvg-wasm → rich cards | ✅ | ✅✅ | new dep + bundled font; design work |

Option A "works" but re-introduces exactly the native-binary fragility that
caused the incident. Option C puts a network hop in the notification hot-path and
(for QuickChart) sends user portfolio data to a third party. B and D share the
same portable WASM rasterizer and avoid both problems.

## Recommendation — two phases

### Phase 1 — Portable rasterizer: `@resvg/resvg-js` → `@resvg/resvg-wasm`

Deletes the entire native-binary / `External` / layer problem class. One WASM
artifact renders **identically** on Lambda, Vercel, local, and the browser. It is
the smallest change that turns charts back on in prod, and because the code
already degrades gracefully it can land incrementally with no notification
regression.

**Implementation sketch:**

1. Add `@resvg/resvg-wasm`; remove `@resvg/resvg-js` once cut over.
2. Rewrite `renderChartPng()` in `parts/charts/candlestick.ts`:
   - `@resvg/resvg-wasm` requires a one-time `await initWasm(wasmBinary)` before
     first render. Cache an init promise at module scope (same lazy-singleton
     shape as today's `loadResvg()`), so concurrent renders in one Lambda
     invocation share a single init.
   - Rendering becomes **async** — `renderChartPng()` returns
     `Promise<Buffer | null>`. Propagate the `await` up through
     `formatPriceAlertTelegram()` and any digest chart callers. Keep the
     `null` → text-only fallback exactly as-is.
3. **Getting the `.wasm` into the SAM esbuild bundle** (the main integration
   detail):
   - Preferred: esbuild loader `{ '.wasm': 'binary' }` (or `'file'`) so the
     `index_bg.wasm` is emitted as an asset and read at runtime. Verify SAM's
     `BuildProperties` passes the loader through; if not, fall back to copying
     the `.wasm` into `CodeUri` and reading it with `fs.readFileSync` at init.
   - Remove `@resvg/resvg-js` from the `External` list in `aws/template.yaml`
     (all three functions that render).
4. **Gate:** `npm run build:lambdas` (the pre-push offline bundle build) must
   succeed with the wasm bundled — this is the exact check that caught the
   original `.node` break, so it directly proves the fix.
5. **Verify on Lambda:** invoke `stocktextalerts-live-provider-check` or a
   scheduled function against a test chat and confirm a real PNG arrives.

**Why async is acceptable:** these are cron/alert Lambdas with a 300s timeout,
not a latency-critical request path. A one-time ~tens-of-ms wasm init per cold
start is negligible.

#### Phase 1 as implemented (2026-07-03)

The sketch above held, with two deviations discovered during implementation:

- **Asset delivery is a deploy-script copy, not an esbuild loader.** SAM's
  esbuild `BuildProperties` loader support wasn't needed: the shared
  `aws/chart-assets.sh` helper (`copy_chart_assets`) copies the `.wasm` + fonts
  into every function build dir after `sam build`, on BOTH deploy paths —
  `deploy-web.sh build_lambdas` (pre-push `--build` gate, CI `--deploy-ci`,
  local break-glass) and `deploy.sh` (`deploy:infra`, whose `sam deploy`
  packages the same build dirs). At runtime `candlestick.ts` reads assets
  dual-path: `LAMBDA_TASK_ROOT` first (Lambda), then node_modules subpath
  resolution (local dev / vitest; not verified on Vercel).
- **Fonts had to ship too.** `@resvg/resvg-wasm` loads NO system fonts (unlike
  the native build's `loadSystemFonts`) — and Lambda has none anyway — so the
  chart's axis text would render blank. Roboto 400/500 TTFs (OFL, pinned via
  `@expo-google-fonts/roboto`) ship alongside the wasm and are passed as
  `fontBuffers` on every render. A missing font fails closed (text-only + red
  live check), not silently label-less.

Also landed with Phase 1: the design findings (hollow rising / solid falling
bodies so direction survives grayscale; a direction-colored last-price tag in
the right gutter) and a `chart:render-png` step in the live-provider-check
Lambda, so a bundle missing chart assets fails the post-deploy check red
instead of silently regressing every Telegram alert to text-only.

### Phase 2 — Designed cards with Satori

Once rasterization is portable, replace the hand-built candlestick SVG with
**Satori** templates: author the card as JSX (price table + intraday chart +
session badge + branding), Satori → SVG, resvg-wasm → PNG.

**Implementation sketch:**

1. Add `satori`; bundle a font (Satori needs explicit font buffers — e.g. Inter
   subset). Ship the font as a bundled asset like the wasm.
2. Build a `parts/charts/card.tsx` (or `.ts` with `h()` calls) template taking
   the same inputs the Telegram renderer already has: `userAssets`,
   `assetPrices`, `sessionLabel`, intraday candles.
3. Keep the candlestick as an inline SVG *inside* the Satori card, or render the
   chart region separately and compose — TBD during design.
4. Design targets: bold header, per-asset rows with 🟢/🔴 direction + price +
   signed change%, an intraday chart, a subtle brand footer. Dark and light
   variants (Telegram themes both).

**Deferred design questions (Phase 2):** one card per alert vs. a digest card;
chart type (candlestick vs. area/sparkline) at card size; font licensing/subset;
image dimensions for Telegram `sendPhoto` (Telegram downscales large images).

## Bonus: this also fixes the dashboard preview fidelity

The dashboard "Notification Preview" (`preview/NotificationPreview.vue`)
currently renders a Telegram-styled bubble around the **plaintext** asset list —
an approximation, because the real Telegram renderer emits grammY
`FormattedString` entities and the chart is a server-rasterized PNG the browser
can't reproduce today.

**After Phase 1, WASM runs in the browser too.** The preview can then render the
*actual* Telegram message + the *actual* chart image using the same renderer and
rasterizer — a single source of truth, no drift. This is the proper resolution to
"shouldn't the preview use the real renderer?"

**Interim (until Phase 1):** the preview stays as the current Telegram-styled
approximation. If desired later, it can be tightened to mirror the real Telegram
text format (bold "📈 Price Update" header, 🟢/🔴 dots, bold tickers, `/stop`
footer) using the existing **pure** helpers in `parts/asset-price-list.ts`
(`directionDot`, `formatUsdPrice`, `formatSignedChangePercent`,
`resolveDisplayChangePercent`) — no grammY, no client bundle risk.

## Risks & mitigations

- **WASM bundling in SAM esbuild** — the one unknown. De-risk first with a
  throwaway `npm run build:lambdas` spike before committing to the cutover.
- **Async propagation** — `renderChartPng` becoming async touches every caller;
  small and mechanical, covered by the existing send-path transformer tests
  (`test(telegram): real send-path transformer tests`, `9203d27b`).
- **Bundle size** — the resvg wasm (~1–2 MB) plus a font subset (Phase 2) grow
  the Lambda package. Well within limits; note it, don't block on it.
- **No prod regression while landing** — the `null` → text-only fallback means a
  half-finished cutover degrades to today's behavior, never a crash.

## Suggested sequencing

1. Spike: prove `@resvg/resvg-wasm` bundles + renders under
   `npm run build:lambdas`.
2. Phase 1 cutover + Lambda live-verify → charts back on in prod.
3. Point the dashboard preview at the real renderer + wasm chart.
4. Phase 2: Satori card design + templates.
