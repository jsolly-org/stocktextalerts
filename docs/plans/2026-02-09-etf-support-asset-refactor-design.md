# ETF Support + Stock-to-Asset Refactor

**Date:** 2026-02-09
**Status:** Planned

## Overview

Add ETF support and comprehensively rename "stock" to "asset" across the entire codebase -- database tables, RPC functions, API routes, types, functions, files, directories, variables, UI labels, and test infrastructure. Wire up us-assets.json as the data source. Filter ETFs out of daily/weekly notifications.

## Guiding Principles

- **Rename aggressively**: every code identifier, file, directory, DB object, and UI string that says "stock" becomes "asset" (or "watchlist" for the UI section heading)
- **Keep as-is**: the app name `StockTextAlerts`/`stocktextalerts`, Finnhub API URLs (`/stock/symbol`), the `type` data value `"stock"` in us-assets.json, and timezone `Europe/Stockholm`
- **Initial migration**: do NOT modify the existing `20250101000000_initial_schema.sql` -- create a new migration that renames/alters on top of it
- **Order of operations**: migration first, then db:gen-types, then code changes (so generated types are correct)

---

## 1. Database Migration

Create a new migration file in `supabase/migrations/` that:

**Rename tables:**

```sql
ALTER TABLE stocks RENAME TO assets;
ALTER TABLE user_stocks RENAME TO user_assets;
```

**Schema changes on assets:**

```sql
ALTER TABLE assets DROP COLUMN exchange;
ALTER TABLE assets ADD COLUMN type TEXT NOT NULL DEFAULT 'stock'
  CHECK (type IN ('stock', 'etf'));
```

**Rename constraints and indexes:**

- `stocks_pkey` -> `assets_pkey`
- `stocks_symbol_no_whitespace` -> `assets_symbol_no_whitespace`
- `user_stocks_pkey` -> `user_assets_pkey`
- `user_stocks_user_id_fkey` -> `user_assets_user_id_fkey`
- `user_stocks_symbol_fkey` -> `user_assets_symbol_fkey`
- `user_stocks_max_limit` constraint name referenced in RPC -> `user_assets_max_limit`

**Drop and recreate RPC function:**

- Drop `replace_user_stocks`
- Create `replace_user_assets` with identical logic but referencing `user_assets` and `assets` tables
- Update error messages inside the function: "Stock symbol contains whitespace" -> "Asset symbol contains whitespace", "Tracked stocks limit exceeded" -> "Tracked assets limit exceeded", etc.

**Update RLS policies:**

- Drop old policies on `assets` (formerly `stocks`): "Anyone can view stocks"
- Create new: "Anyone can view assets" on `assets` FOR SELECT USING (true)
- Drop old policies on `user_assets` (formerly `user_stocks`): "Users can view own stocks", "Users can insert own stocks", "Users can delete own stocks"
- Create new: "Users can view own assets", "Users can insert own assets", "Users can delete own assets"
- Update GRANT statements for new table names

## 2. Seed Infrastructure

**scripts/db/generate-seed.ts:**

- `STOCKS_FILE` -> `ASSETS_FILE`, point to `scripts/us-assets.json`
- `Stock` type -> `Asset` type: `{ symbol: string; name: string; type: string }` (drop `exchange`, add `type`)
- `generateStocksSql()` -> `generateAssetsSql()`: insert into `public.assets` with columns `(symbol, name, type)`, use `ON CONFLICT (symbol) DO UPDATE SET name = EXCLUDED.name, type = EXCLUDED.type`
- Update all variables: `stocksData` -> `assetsData`, `stocksRaw` -> `assetsRaw`, `stocks` -> `assets`
- Update SQL section comment: "1. Stocks" -> "1. Assets", "2. Users ... tracked stocks" -> "tracked assets"
- Error key `stocks_read_failed` -> `assets_read_failed` and all its messages (e.g., "us-stocks.json" -> "us-assets.json", "stocks[i]" -> "assets[i]")
- `tracked_stocks` validation block: rename property references `user.tracked_stocks` -> `user.tracked_assets`, loop variable `stock` -> `asset`, error messages "tracked_stocks[i]" -> "tracked_assets[i]"
- Update log messages

**scripts/data/sample-users.json:**

- Rename `tracked_stocks` key -> `tracked_assets` on all user entries (5 occurrences)

**scripts/db/seed-sql.ts:**

- `buildUserStocksSql()` -> `buildUserAssetsSql()`: reference `public.user_assets` and `public.assets`
- Update parameter name `trackedStocks` -> `trackedAssets`
- Update variable `stocksValues` -> `assetsValues`

## 3. File & Directory Renames

**Directories:**

- `src/components/dashboard/stocks/` -> `src/components/dashboard/assets/`
- `src/pages/api/stocks/` -> `src/pages/api/assets/`
- `tests/api/stocks/` -> `tests/api/assets/`

**Source files:**

- `src/components/dashboard/stocks/StockInput.vue` -> `assets/AssetInput.vue`
- `src/components/dashboard/stocks/TrackedStocksPanel.vue` -> `assets/WatchlistPanel.vue`
- `src/components/dashboard/stocks/types.ts` -> `assets/types.ts`
- `src/pages/api/stocks/update.ts` -> `src/pages/api/assets/update.ts`
- `src/lib/messaging/stock-formatting.ts` -> `src/lib/messaging/asset-formatting.ts`

**Test files:**

- `tests/helpers/stock-data.ts` -> `tests/helpers/asset-data.ts`
- `tests/helpers/stock-update.ts` -> `tests/helpers/asset-update.ts`
- `tests/api/stocks/update-stocks.test.ts` -> `tests/api/assets/update-assets.test.ts`
- `tests/api/stocks/update-stocks.security.test.ts` -> `tests/api/assets/update-assets.security.test.ts`

**All import paths** referencing old locations must be updated across every consuming file.

## 4. Code Renames (Types, Functions, Constants, Variables)

### Types

- `StockPrice` -> `AssetPrice` (price-fetcher.ts, asset-formatting.ts)
- `StockPriceMap` -> `AssetPriceMap` (price-fetcher.ts)
- `StockWithName` -> `AssetWithName` (asset-formatting.ts)
- `DbStockRow` -> `DbAssetRow` (db/index.ts)
- `DbUserStockRow` -> `DbUserAssetRow` (db/index.ts)
- `Stock` (export) -> `Asset` (db/index.ts)
- `UserStock` -> `UserAsset` (db/index.ts)
- `UserStockRow` -> `UserAssetRow` (messaging/types.ts)
- `StockOption` -> `AssetOption` (AssetInput.vue)
- `InitialStock` -> `InitialAsset` (assets/types.ts)
- `PreviewStock` -> `PreviewAsset` (preview-data.ts)
- `StockData` -> `AssetData` (tests/helpers/asset-data.ts)
- `DbUserStockInsert` -> `DbUserAssetInsert` (tests/helpers/test-user.ts)

### Functions

- `fetchStockQuote` -> `fetchAssetQuote` (price-fetcher.ts)
- `fetchStockPrices` -> `fetchAssetPrices` (price-fetcher.ts)
- `getUserStocks` -> `getUserAssets` (db/index.ts)
- `loadUserStocks` -> `loadUserAssets` (schedule/helpers.ts)
- `formatStockBaseText` -> `formatAssetBaseText` (asset-formatting.ts)
- `formatStockPriceText` -> `formatAssetPriceText` (asset-formatting.ts)
- `formatStockTextLine` -> `formatAssetTextLine` (asset-formatting.ts)
- `formatStockHtmlLine` -> `formatAssetHtmlLine` (asset-formatting.ts)
- `formatStocksTextList` -> `formatAssetsTextList` (asset-formatting.ts)
- `formatStocksHtmlList` -> `formatAssetsHtmlList` (asset-formatting.ts)
- `generateStocksSql` -> `generateAssetsSql` (generate-seed.ts)
- `buildUserStocksSql` -> `buildUserAssetsSql` (seed-sql.ts)
- `loadStockData` -> `loadAssetData` (tests/helpers/asset-data.ts)
- `getStockData` -> `getAssetData` (tests/helpers/asset-data.ts)
- `getRealStockSymbols` -> `getRealAssetSymbols` (tests/helpers/asset-data.ts)
- `updateTrackedStocks` -> `updateTrackedAssets` (tests/helpers/asset-update.ts)
- `ensureStocksExist` -> `ensureAssetsExist` (tests/helpers/asset-update.ts)
- `stocksUpdatePost` -> `assetsUpdatePost` (tests/helpers/asset-update.ts)

### Constants

**src/lib/constants.ts:**

- `DASHBOARD_STOCKS_FORM_ID` -> `DASHBOARD_ASSETS_FORM_ID`
- `DASHBOARD_STOCKS_STATUS_ID` -> `DASHBOARD_ASSETS_STATUS_ID`
- Section ID: `stocks: "tracked-stocks"` -> `assets: "watchlist"`
- Section hash: `stocks: '#${DASHBOARD_SECTION_IDS.stocks}'` key -> `assets: '#${DASHBOARD_SECTION_IDS.assets}'`
- Flash messages: `stock_added` -> `asset_added`, `stock_removed` -> `asset_removed`, `stocks_updated` -> `assets_updated`, `failed_to_add_stock` -> `failed_to_add_asset`, `failed_to_remove_stock` -> `failed_to_remove_asset`, `failed_to_update_stocks` -> `failed_to_update_assets`, `stocks_limit` -> `assets_limit`

**src/lib/db/database-errors.ts:**

- `MAX_TRACKED_STOCKS` -> `MAX_TRACKED_ASSETS`
- `MESSAGE_STOCKS_LIMIT_EXCEEDED` -> `MESSAGE_ASSETS_LIMIT_EXCEEDED`
- `MESSAGE_STOCKS_WHITESPACE` -> `MESSAGE_ASSETS_WHITESPACE`
- `isStocksLimitError` -> `isAssetsLimitError`
- `isStocksWhitespaceError` -> `isAssetsWhitespaceError`
- Update constraint name references from `user_stocks_max_limit` to `user_assets_max_limit`

**src/lib/messaging/asset-formatting.ts:**

- `NO_TRACKED_STOCKS_MESSAGE` -> `NO_TRACKED_ASSETS_MESSAGE`

### Variables (rename throughout all files)

- `userStocks` -> `userAssets`
- `assetOptions` (was `stockOptions`)
- `draftStocks` -> `draftAssets`
- `trackedStocks` -> `trackedAssets`
- `stocksList` -> `assetsList`
- `stocksData` -> `assetsData`
- `currentStocks` -> `currentAssets`
- `isStocksSaving` -> `isAssetsSaving`
- `stocksStatusMessage` -> `assetsStatusMessage`
- `stocksStatusTone` -> `assetsStatusTone`
- `stocksFormElement` -> `assetsFormElement`
- `selectedStock` -> `selectedAsset`
- `filteredStocks` -> `filteredAssets`
- `selectStock` -> `selectAsset`
- `isAtStockLimit` -> `isAtAssetLimit`
- `STOCK_LIMIT_HINT_ID` -> `ASSET_LIMIT_HINT_ID`
- `trackedStocksValue` -> `trackedAssetsValue`
- `stockRecords` -> `assetRecords`
- `stockInserts` -> `assetInserts`
- `stockDataCache` -> `assetDataCache`
- `allUserStocks` -> `allUserAssets` (schedule/run.ts)
- `userStocksError` -> `userAssetsError` (schedule/run.ts)
- `stocksTableError` -> `assetsTableError` (tests/helpers/test-user.ts)
- `stockError` -> `assetError` (tests/helpers/test-user.ts)
- `stockCount` -> (keep or rename in fetch-us-assets.ts -- this counts `type === "stock"` assets)
- `stockInfo` -> `assetInfo` (asset-formatting.ts)
- `escapedStocksListHtml` -> `escapedAssetsListHtml` (email/utils.ts)

### Vue Event Names

- `stocks-changed` -> `assets-changed` (WatchlistPanel emit and DashboardPanels listener)

### API Endpoint

- Form field name: `tracked_stocks` -> `tracked_assets` (in update.ts and asset-update.ts test helper)
- Schema constant: `STOCKS_SCHEMA` -> `ASSETS_SCHEMA`
- Form action: `/api/stocks/update` -> `/api/assets/update` (DashboardPanels.vue)
- URL in tests: `http://localhost/api/stocks/update` -> `http://localhost/api/assets/update`
- RPC call: `.rpc("replace_user_stocks", ...)` -> `.rpc("replace_user_assets", ...)`

## 5. Notification Logic

**`loadUserAssets` in src/lib/schedule/helpers.ts:**

- Update table reference from `stocks` to `assets` in select: `.select("symbol, assets!inner(name, type)")`
- Include `type` in returned objects
- Rename local variable `stocks` -> `assets` and inner mapping `stock.stocks.name` -> `asset.assets.name`
- Comment: "tracked stocks" -> "tracked assets"

**`UserAssetRow` in src/lib/messaging/types.ts:**

- Add `type` field referencing `Database["public"]["Tables"]["assets"]["Row"]["type"]`

**Daily digest in src/lib/schedule/run-user-daily.ts:**

- After `loadUserAssets()`, filter for extras:
  ```typescript
  const stockTickers = userAssets.filter(a => a.type === 'stock').map(a => a.symbol);
  ```
- Pass `stockTickers` to `fetchFinnhubExtras()` instead of all tickers

**Weekly calendar in src/lib/schedule/run-user-weekly.ts:**

- Same filter pattern before `fetchWeeklyCalendarData()`
- Skip weekly notification entirely if user has only ETFs (no earnings to report)
- Log message: `"no tracked stocks"` / `"no_stocks"` reason -> `"no tracked assets"` / `"no_assets"`

**Price notifications (src/lib/schedule/run-user.ts):**

- No logic changes needed for asset-type filtering -- works for all asset types
- Rename identifiers: `formatStocksTextList` import -> `formatAssetsTextList`, import path `stock-formatting` -> `asset-formatting`
- `loadUserStocks` import -> `loadUserAssets`, `StockPriceMap` -> `AssetPriceMap`
- Variables: `userStocks` -> `userAssets`, `stocksList` -> `assetsList`
- Comments: "stock update" -> "asset update"

**Batch price fetch (src/lib/schedule/run.ts):**

- `fetchStockPrices` import -> `fetchAssetPrices`, `StockPriceMap` -> `AssetPriceMap`
- Variables: `allUserStocks` -> `allUserAssets`, `userStocksError` -> `userAssetsError`
- Table reference: `.from("user_stocks")` -> `.from("user_assets")`
- Comment: "Collect unique stock symbols" -> "Collect unique asset symbols"
- Log message: "Failed to load user stocks" -> "Failed to load user assets"

**Scheduled delivery (src/lib/schedule/run-user-delivery.ts):**

- `UserStockRow` import -> `UserAssetRow`, `StockPriceMap` -> `AssetPriceMap`
- Parameters: `userStocks` -> `userAssets`, `stocksList` -> `assetsList`, `priceMap: StockPriceMap` -> `AssetPriceMap`
- Comments: "stock update" -> "asset update"

**Daily delivery (src/lib/schedule/run-user-daily-delivery.ts):**

- Import path `stock-formatting` -> `asset-formatting`, `UserStockRow` -> `UserAssetRow`
- Parameters: `userStocks` -> `userAssets` throughout all functions
- Email subject: `"Daily stock digest"` -> `"Daily digest"`

**Weekly delivery (src/lib/schedule/run-user-weekly-delivery.ts):**

- UI strings: `"tracked stocks this week"` -> `"tracked assets this week"` (SMS and email text)
- `"Upcoming events for your tracked stocks"` -> `"Upcoming events for your tracked assets"`

## 5b. Messaging Layer Renames

**src/lib/messaging/email/utils.ts:**

- Imports: `StockPriceMap` -> `AssetPriceMap`, `formatStocksHtmlList` -> `formatAssetsHtmlList`, import path `stock-formatting` -> `asset-formatting`, `UserStockRow` -> `UserAssetRow`
- Parameters: `userStocks` -> `userAssets`, `stocksList` -> `assetsList`, `priceMap: StockPriceMap` -> `AssetPriceMap`
- Variable: `escapedStocksListHtml` -> `escapedAssetsListHtml`
- UI strings: `"tracked stocks"` -> `"tracked assets"`, `"Tracking Stocks"` -> `"Tracking Assets"`, `"Add Stocks to Track"` -> `"Add Assets to Track"`, `"Your Stock Update"` -> `"Your Update"`, `"add stocks to your dashboard"` -> `"add assets to your dashboard"`
- Comment: "stock update" -> "asset update"

**src/lib/messaging/email/delivery.ts:**

- Imports: `StockPriceMap` -> `AssetPriceMap`, `UserStockRow` -> `UserAssetRow`
- Parameters: `userStocks` -> `userAssets`, `stocksList` -> `assetsList`
- Email subject: `"Your Stock Update"` -> `"Your Update"`

**src/lib/messaging/email/html-section.ts:**

- Import path: `stock-formatting` -> `asset-formatting`

**src/lib/messaging/email/email-layout.ts:**

- Import path: `stock-formatting` -> `asset-formatting`

**src/lib/messaging/sms/delivery.ts:**

- Import: `NO_TRACKED_STOCKS_MESSAGE` -> `NO_TRACKED_ASSETS_MESSAGE`, import path `stock-formatting` -> `asset-formatting`
- Parameter: `stocksList` -> `assetsList`
- Comment: "stock update" -> "asset update"

## 6. UI Label Updates

**WatchlistPanel.vue (after rename):**

- Heading: "Tracked Stocks" -> "Watchlist"
- Aria-labels: "X stocks tracked" -> "X assets tracked"
- Legend: "Add stocks" -> "Add to watchlist"
- Limit message: "maximum of X stocks" -> "maximum of X assets"
- Count label: "tracked stock/stocks" -> "tracked asset/assets"
- Empty state: "Search above to add stocks." -> "Search above to add assets."
- `for="stock_search"` label -> `for="asset_search"`
- `STOCK_LIMIT_HINT_ID` value: `"stock-limit-hint"` -> `"asset-limit-hint"`

**AssetInput.vue (after rename):**

- Element IDs: `stock_search` -> `asset_search`, `stock_dropdown` -> `asset_dropdown`, `stock_option_${index}` -> `asset_option_${index}`
- ARIA references: `aria-controls`, `aria-activedescendant` updated to match new IDs
- Empty search: "No stocks found" -> "No assets found"

**DashboardPanels.vue:**

- Aria-label: "Tracked stocks" -> "Watchlist"

**constants.ts:**

- Toast messages: "Stock added successfully" -> "Asset added successfully", etc.

**dashboard.astro:**

- Meta description and page text

**Notification panels:**

- OccasionalNotificationsPanel.vue: "tracked stocks" -> "tracked assets"
- DailyNotificationsPanel.vue: "stocks you're tracking" -> "assets you're tracking"
- ScheduledNotificationsPanel.vue: "stock price updates" -> "asset price updates"
- NotificationPreviewPanel.vue: "stock notifications" -> "asset notifications", "tracked stocks" -> "tracked assets"
- FormatToggles.vue: "each stock price" -> "each asset price", "between stocks" -> "between assets"
- preview-data.ts: "tracked stocks"
- EmailPreview.vue: "Your Stock Update" heading -> "Your Update", `.email-stocks-section` CSS class -> `.email-assets-section`
- SmsPreview.vue: "Your tracked stocks:" -> "Your tracked assets:"

**Landing pages:**

- Hero.astro: "Stock updates on your schedule" -> "Asset updates on your schedule", "tracked stocks" -> "tracked assets"
- Features.astro: "tracked stocks" -> "tracked assets"
- HowItWorks.astro: "Pick your stocks" -> "Pick your assets"
- CTA.astro: "stock info" -> "asset info", "Track your stocks" -> "Track your assets"
- NotificationPreview.astro: alt text "stock alert" -> "asset alert"

**Auth pages:**

- signin.astro: meta description "tracked stocks" -> "tracked assets"
- register.astro: meta description "tracked US stocks" -> "tracked US assets"
- verified.astro: "tracked stocks" -> "tracked assets"

**404.astro:**

- Comment: "Fake stock ticker" -> "Fake ticker"
- Text: "your real stocks are doing better" -> "your real assets are doing better"

**index.astro:**

- JSON-LD description: "tracked stocks" -> "tracked assets"
- Layout description: "tracked stocks" -> "tracked assets"

**faq.astro:** Update FAQ text (keep "StockTextAlerts" app name)

**README.md:** Update references to "stocks", file paths (`us-stocks.json` -> `us-assets.json`), feature descriptions. Keep app name.

**scripts/db/db-reset-prod.ts:** Comment "stock list" -> "asset list"

**tests/SANITY.md:** Update test case descriptions (TC-STK -> TC-AST or similar)

## 7. Test Updates

- Rename all test files (see Section 3)
- tests/helpers/asset-data.ts: point to `us-assets.json`, `AssetData` type (drop `exchange`, add `type`)
- tests/helpers/asset-update.ts: reference `/api/assets/update`, `user_assets` table, `replace_user_assets` RPC
- tests/helpers/test-user.ts: rename types, variables, table references (`user_stocks` -> `user_assets`, `stocks` -> `assets`), option property `trackedStocks` -> `trackedAssets`
- tests/admin/cascade-delete.test.ts: rename test description "user_stocks" -> "user_assets", option `trackedStocks` -> `trackedAssets`, variables `stocksBefore`/`stocksAfter` -> `assetsBefore`/`assetsAfter`, table reference `.from("user_stocks")` -> `.from("user_assets")`, comments
- tests/lib/messaging/sms-format.test.ts: add `type: "stock"` to `UserAssetRow` fixtures, update import
- tests/lib/messaging/email-format.test.ts: same
- tests/lib/db/constraints.test.ts: reference `replace_user_assets` RPC, update INSERT statements to drop `exchange` column and use `assets` table, rename variables `realStock` -> `realAsset`, `aaplStock` -> `aaplAsset`, `msftStock` -> `msftAsset`, update constraint/table names in assertions (`stocks_symbol_no_whitespace` -> `assets_symbol_no_whitespace`, `stocks` -> `assets`)
- tests/lib/messaging/sms-format.test.ts: rename variables `stocksList` -> `assetsList`, `manyStocks` -> `manyAssets`, test descriptions "stock" -> "asset"
- tests/lib/messaging/email-format.test.ts: rename `testStocks` -> `testAssets`, `stocksList` -> `assetsList`, `StockPriceMap` -> `AssetPriceMap`, test descriptions "stock" -> "asset"
- Update test descriptions throughout: "tracked stocks" -> "tracked assets"

## 8. Verification

After all changes:

1. `npm run db:reset` -- resets local DB with new migration + seed from `us-assets.json`
2. `npm run db:gen-types` -- regenerate types (confirms new table/column names in generated file)
3. `npm run check:ts` -- confirm no type errors
4. `npm run test` -- confirm unit tests pass
5. `npm run build` -- confirm build works (dashboard.astro reads new JSON)
6. Manual smoke test: open dashboard, search for an ETF (e.g., "SPY"), verify it appears in search
