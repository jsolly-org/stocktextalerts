# Ticker Universe Reconcile (prod asset-universe refresh)

**Status:** Implemented — gate-green locally, pending integration (rebase onto `origin/main` + `/ship`).
**Date:** 2026-06-20
**Host:** the daily asset-maintenance Lambda (new `runUniverseReconcile` step), composing with the existing `runDelistingSweep`. **This Lambda is renamed** `asset-events` → `asset-maintenance` as part of this work, since it now does far more than fetch asset events (see "Lambda rename").

## Implementation status (2026-06-21)

Built and verified locally: `check:ts` (0 errors), `check:biome` (clean), `check:knip` (clean),
`tests/lib/assets/universe-reconcile.test.ts` (**12/12 pass**), `check:db-privileges` OK.

Files: migration `supabase/migrations/20260620165957_add_assets_reference_columns.sql`
(`reference_updated_utc` + `composite_figi` + `GRANT INSERT … service_role`, schema_version bump);
`src/lib/vendors/massive.ts` (`fetchActiveTickers`, `fetchTickerDetail`, `ActiveTicker`);
`src/lib/assets/universe-reconcile.ts`; `src/handlers/asset-maintenance.ts` (renamed, wired);
full `asset-events`→`asset-maintenance` infra rename across `aws/template.yaml`, `aws/deploy-web.sh`,
`aws/package.json`, `aws/sam-local.sh`, `docs/shared-infra.md`; `tests/helpers/constants.ts`
(`EXPECTED_DB_SCHEMA_VERSION`); generated DB types.

Adversarial-review fixes applied: paginated the step-3 `user_assets` read (the tracked carve-out's
only input — an unbounded read truncates at 1000 rows and could flag a tracked symbol delisted);
made `ACTIVE_TICKER_TYPES`/`validateNextUrl` module-private; added provider-miss and throw-isolation
enrichment tests (`result.enrichmentFailed` was previously asserted nowhere).

**Integration caveat:** the worktree base is behind `origin/main` (the "release SHA on every log line"
commits). The branch MUST be rebased onto current `origin/main` before the push, or integration reverts
that feature. `/ship` handles integration + the full gate + the required **`npm run deploy:aws`**
(CloudFormation replacement from the Lambda rename) + migration via `supabase db push`.

## Spec

### Goal

Keep the production `public.assets` universe current and clean — automatically, decoupled from
code deploys — so that:

1. **New listings** (IPOs, new ETFs) become searchable/trackable without a manual prod reseed.
2. **Stale untracked symbols** stop polluting the search surface (the prod table holds ~27.7k rows
   against a ~10.6k *active* universe — see "Findings" below).
3. **Sector / icon enrichment** stays reasonably current (today ~84% of prod rows have no sector,
   ~88% no icon).

### Problem (why this exists)

There is **no current path — automated or scripted — that loads the asset universe into production.**
Confirmed by tracing every write to `assets`:

- `scripts/db/generate-seed.ts` only `fs.writeFileSync`s `supabase/seed.sql` (local file); it never
  writes asset rows to a DB.
- `scripts/db/reset.ts` runs `supabase db reset` against the **local** worktree stack only.
- The old `scripts/db/db-reset-prod.ts` was deleted at commit `dedd9bcd`.
- The only automated prod writes to `assets` are the daily delisting sweep (stamps `delisted_at` on
  *tracked* symbols) and `logo-fetcher` (lazy `icon_base64` for tracked symbols at send time).

The prod `assets` table is therefore a **frozen artifact of historical manual seed loads**, last
meaningfully refreshed around the March 2026 bulk Massive import (commit `e5371c07`). New listings
since then are invisible to users.

### What already exists (reuse, do not rebuild)

- **`runDelistingSweep`** (`src/lib/assets/delisting-sweep.ts`): daily, tracked-symbol-scoped.
  Confirms delisting per-symbol via Massive `fetchTickerReferences` (`active=false`), stamps
  `assets.delisted_at`, notifies users (email + SMS), deletes their `user_assets` + `price_targets`
  rows. **This is the "notify + auto-remove" behavior we want for tracked symbols — keep it as-is.**
- **Add-surface gating** (`src/pages/api/assets/update.ts:86`): already rejects symbols with
  `delisted_at` set.
- **`fetchTickerReferences`** (`src/lib/vendors/massive.ts`): strict `active:false` / `delisted_utc`
  detection with an injection seam for tests.
- **`enqueueNewSymbolWarmup`** (`src/lib/vendor-backfill/queue.ts`): existing SQS path to warm a new
  symbol's price/OHLCV data. The reconcile feeds this for newly-discovered symbols.

### Acceptance

- A daily run discovers new active listings and upserts them into `assets` (name + type) and enriches
  sector/icon for new/changed symbols (gated, capped).
- Untracked symbols absent from Massive's active set get `delisted_at` stamped (drains the backlog).
- Tracked-symbol delisting continues to flow **only** through the existing confirm-based
  `runDelistingSweep` (no false-positive removals — see Risk 1).
- New symbols are enqueued for price warmup via `enqueueNewSymbolWarmup`.
- Steady-state daily run completes well within the `asset-events` Lambda's 300s timeout.
- Unit tests cover: new-listing upsert, name-update, untracked-delist flag, enrichment gating, and the
  tracked-symbol safety carve-out — all with Massive stubbed (no live keys locally).

## Findings (live prod, read-only — 2026-06-20)

- `assets`: **27,686** rows (21,428 stock / 6,258 etf); `delisted_at` set on **1**; sector on 4,512
  (16%); icon on 3,438 (12%).
- `user_assets`: 43 rows, 34 distinct symbols, 9 users. **All 34 tracked symbols are currently
  listed** — no one tracks a delisted/invalid symbol today. (ETF sector/icon nulls e.g. VOO/VUG/VXUS
  are expected — ETFs have no SIC code.)
- Implication: the 27k bloat is almost entirely *untracked* rows — a search-surface hygiene problem,
  not active user-facing corruption. The one real user-facing bug is "can't find a recent listing."

## Endpoint verification (2026-06-20, live)

A live call to `/v3/reference/tickers?active=true&limit=2&type=CS` confirmed per-row fields:
`active, cik, composite_figi, currency_name, last_updated_utc, locale, market, name, primary_exchange,
share_class_figi, ticker, type`. The `active=false` probe additionally returns `delisted_utc`.

- **`last_updated_utc` is per-row** → the enrichment gate (step 4) is viable as designed.
- **`active` + `delisted_utc` per-row** → bulk active/delisted reconcile from the list endpoint, no
  per-symbol calls for delisting detection.
- **`composite_figi` + `cik` are returned free on every list row** → the stable-identity hardening
  (Risk 4) costs no extra API calls. Recommend capturing `composite_figi` into a new nullable
  `assets.composite_figi` column now (populated opportunistically during reconcile), even if v1 still
  *keys* on `symbol` — it makes a future symbol-reuse defense a data-only change, not a re-fetch.

## Design

### Where it runs

Fold a new `runUniverseReconcile` step into the asset-maintenance handler
(`src/handlers/asset-maintenance.ts` post-rename), ordered **before** `runDelistingSweep`, in its own
independent `try/catch` (matching the existing per-step isolation so a reconcile failure never
invalidates the events job or the sweep).

`vendor-backfill` (SQS) is deliberately **not** the host — it is a retry/warmup queue of discrete
units, not a scheduled full sweep. The reconcile *integrates* with it via `enqueueNewSymbolWarmup`.

Lambda budget: the function is `Timeout: 300`, `MemorySize: 512`, `cron(0 0 * * ? *)` (midnight UTC ≈
7–8pm ET — after US market close, so Massive's nightly ticker re-sync is fresh).

### Lambda rename (`asset-events` → `asset-maintenance`)

The Lambda was named after its original sole job (fetching the earnings calendar). It now also runs
Finnhub enrichment, the delisting sweep, and this reconcile, so rename it to
`stocktextalerts-asset-maintenance` / logical ID `AssetMaintenanceFunction`.

**Rename these (the Lambda + its infra only):**

- `src/handlers/asset-events.ts` → `src/handlers/asset-maintenance.ts` (and the `function: "asset-events"`
  logger context → `"asset-maintenance"`). Action/log strings like `daily_asset_events_cron` can stay or
  be renamed `daily_asset_maintenance_cron` — cosmetic; if renamed, update the metric-filter patterns.
- `aws/template.yaml`: logical ID `AssetEventsFunction` → `AssetMaintenanceFunction` (+ every `!Ref`);
  `FunctionName: stocktextalerts-asset-events` → `…-asset-maintenance`; `Handler: asset-events.handler`
  → `asset-maintenance.handler`; esbuild `EntryPoints` `asset-events.ts` → `asset-maintenance.ts`;
  `AssetEventsLogGroup` (+ `LogGroupName /aws/lambda/stocktextalerts-asset-events`); alarms
  `AssetEventsFunctionErrorAlarm`, `AssetEventsFunctionDailyMidnightFailureAlarm`,
  `AssetEventsVendorRetryAlarm` (+ their `AlarmName`s); metric filters `AssetEventsErrorLogFilter`,
  `AssetEventsVendorRetryFilter` (+ `AssetEventsVendorRetryCount` metric name); the schedule-name
  dimension `Value: AssetEventsFunctionDailyMidnight`; the IAM ARN at ~line 417.
- `aws/deploy-web.sh` (`deploy_code AssetEventsFunction stocktextalerts-asset-events`),
  `aws/package.json` (`local:asset-events`), `aws/sam-local.sh` (`AssetEventsFunction`).
- `docs/shared-infra.md` (live log-lookup example pointing at `/aws/lambda/stocktextalerts-asset-events`).

**Do NOT rename:** the `src/lib/asset-events/` earnings-calendar feature domain, the dashboard
`AssetEventsPanel.vue` / `asset-events-notifications` form, or the `kind: "asset-events"` SQS retry
message + `enqueueAssetEventsIngestRetry` — those name the *feature*, which is unchanged. **Leave the
2026-05 incident docs and prior plans as-is** — point-in-time history, not live config.

**Deploy implication (important).** Changing `FunctionName` and the logical ID is a CloudFormation
**replacement**: the old `stocktextalerts-asset-events` function + log group are deleted and a new
`stocktextalerts-asset-maintenance` is created. So this change requires a **full `npm run deploy:aws`
(admin creds, MFA step-up — agent cannot run it)**, not a code-only push. The old log group's history is
orphaned (retention applies separately); there is a brief delete/recreate window on the daily schedule
(negligible at midnight UTC).

**Deploy ORDER is load-bearing — SAM deploy BEFORE the push, not after.** The push triggers
`aws/deploy-web.sh`, whose Phase 2 runs the **one-way** `supabase db push` (migrates prod) and Phase 3
runs `aws lambda update-function-code --function-name stocktextalerts-asset-maintenance`. That function
does **not exist** until the SAM deploy creates it — so a push *before* `deploy:aws` migrates prod and
then aborts Phase 3 under `set -euo pipefail` (`ResourceNotFoundException`), leaving prod DB ahead of
stale code. Correct sequence: **(1)** human runs `npm run deploy:aws` from the worktree (builds from the
working tree — no commit-on-main needed; CloudFormation creates `asset-maintenance`, deletes
`asset-events`); **(2)** then push to `main` → `deploy-web.sh` Phase 3 finds the function and succeeds.
The migration is additive/nullable so the brief code↔schema skew between (1) and (2) is safe.

### Steps (per daily run)

1. **Fetch the complete active set** from Massive's list endpoint
   (`/v3/reference/tickers?active=true&limit=1000`, paginate `next_url`). Bulk — no per-symbol calls.
   Capture per-row `ticker`, `name`, `type`, and `last_updated_utc`.
2. **Upsert** the display-eligible subset (apply the same filters as `fetch-us-assets.ts`: known
   stock/ETF types, skip dotted symbols / empty names) into `assets` (`onConflict: "symbol"`) —
   inserts new listings, updates changed names. Idempotent.
3. **Flag untracked delistings (bulk):** `UPDATE assets SET delisted_at = now() WHERE delisted_at IS
   NULL AND symbol NOT IN (<complete active set>) AND symbol NOT IN (<tracked symbols>)`. Cheap, one
   statement. Drains the ~17k backlog over the first runs without per-symbol calls. **Tracked symbols
   are excluded here** — they remain the exclusive domain of the confirm-based sweep (Risk 1).
4. **Enrich (capped):** for new symbols, and symbols whose `last_updated_utc` advanced since we last
   stored it, call `/v3/reference/tickers/{symbol}` for `branding.icon_url` + `sic_code → sector`
   (reuse `sicCodeToSector`). **Cap at N per run** (e.g. 500) with bounded concurrency (20, as the
   script does) and Massive 429/Retry-After handling (already in `marketDataFetch`). Skip ETFs for
   sector. Backlog of currently-unenriched active rows converges over several days.
5. **Warm new symbols:** `enqueueNewSymbolWarmup(symbol)` for each newly-inserted symbol.
6. **`runDelistingSweep` runs next** (unchanged) — handles the tracked subset authoritatively.

### Schema change

`assets` currently has no field to gate enrichment on. Add:

```sql
ALTER TABLE public.assets ADD COLUMN reference_updated_utc timestamptz;
```

Store Massive's `last_updated_utc` per symbol; step 4 enriches when the incoming value is newer (or the
row is new / unenriched). Migration must `GRANT` per the privilege contract (server-only writes →
`service_role`; the column is session-readable so it rides the existing `authenticated`/`anon` SELECT
grant on `assets`). Bump `app_metadata.schema_version` in SQL **and** `EXPECTED_DB_SCHEMA_VERSION` in
`tests/helpers/constants.ts`. Run `npm run db:gen-types`.

### Code layout

- **Port list-pagination + detail-enrichment out of `scripts/db/fetch-us-assets.ts` into `src/lib`** so
  the Lambda can import it (Lambdas cannot import from `scripts/`). New module
  `src/lib/assets/universe-reconcile.ts` exporting `runUniverseReconcile(deps)`, with injection seams
  (`fetchActiveTickers`, `fetchTickerDetail`) mirroring the delisting-sweep test pattern. The script
  can then re-use the same lib functions (DRY the two-pass fetch).
- Add `fetchActiveTickers()` (paginated list) to `src/lib/vendors/massive.ts` alongside the existing
  `fetchTickerReferences`.

## Risks / decisions

1. **(Decided) False-positive delisting on tracked symbols.** The existing sweep does **not**
   re-confirm an already-flagged `delisted_at` before notify+remove — so if the reconcile flagged a
   *tracked* symbol delisted via mere absence (e.g. our type/dot filters exclude it, or a transient
   Massive omission), the sweep would wrongly remove a live subscription and message the user.
   **Mitigation: step 3 excludes tracked symbols entirely.** Tracked delisting stays 100% on the
   confirm-based `fetchTickerReferences(active=false)` path. Untracked false-positives are harmless
   (a re-listing re-appears in the active set and step 2 clears `delisted_at`).
   - Sub-task: make step 2's upsert clear `delisted_at` (set back to NULL) when a previously-flagged
     symbol reappears active.
2. **First-run timeout.** Steps 1–3 are bulk/fast even at 27k. Only step 4 (enrichment) is per-symbol
   and is **capped per run**, so first-run drains over ~days rather than blowing 300s. No one-off
   manual prod write needed. Confirm a capped run's wall-clock fits with margin; if not, lower N.
3. **Massive rate limits.** Exact plan RPS/RPM unknown (deep-research open question). Bounded
   concurrency + Retry-After + the per-run enrichment cap keep us conservative. Log throttle events.
4. **Symbol reuse / stable identity.** v1 keys on `symbol` (matches the PK; tracked set is tiny and
   clean so reuse-collision risk is ~0 today). `composite_figi`/CIK as a future hardening — noted, not
   built.
5. **Scale reality.** 9 users / 34 tracked symbols. This is built for correctness + future growth, not
   present pain. The cheap alternative (insert-on-search) was considered and deferred in favor of the
   self-maintaining job per the user's call.

## Testing

- Unit (`vitest`, real local Supabase, Massive **stubbed** via injection seams):
  - new listing → inserted with name/type.
  - existing symbol name change → updated.
  - untracked symbol absent from active set → `delisted_at` stamped.
  - **tracked** symbol absent from active set → **not** flagged by reconcile (carve-out).
  - previously-delisted symbol reappears active → `delisted_at` cleared.
  - enrichment gating: unchanged `last_updated_utc` → no detail call; advanced → detail call, sector/
    icon updated; ETF → no sector.
  - enrichment cap respected.
- Update `EXPECTED_DB_SCHEMA_VERSION`; `npm run check:db-privileges` + `check:migration-grants` pass.
- Post-deploy: this touches live-affecting provider code → after push, invoke
  `stocktextalerts-live-provider-check` and confirm no error (per CLAUDE.md live-verification step),
  then spot-check that a known recent listing is now searchable in prod.

## Out of scope

- Backfilling price history for the full universe (rides `enqueueNewSymbolWarmup` per discovered
  symbol, lazily).
- FIGI/CIK stable-identity migration (future).
- Any change to the tracked-symbol notify/remove UX (already shipped and chosen).

## References

- Deep-research report (this session): Massive/Polygon `active`/`delisted_utc` semantics, nightly
  re-sync cadence, two-pass-fetch necessity, seed-file-as-prod-update anti-pattern.
- Existing: `src/lib/assets/delisting-sweep.ts`, `src/handlers/asset-events.ts`,
  `src/lib/vendor-backfill/queue.ts`, `scripts/db/fetch-us-assets.ts`, `src/lib/vendors/massive.ts`.
