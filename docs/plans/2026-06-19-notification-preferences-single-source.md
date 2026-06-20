# Notification preferences: single source of truth

**Spec:** Make `notification_preferences` the SINGLE source of truth for ALL channels
(email, sms, telegram). Migrate every email/SMS read AND write off the 22 per-option
`*_include_{email,sms}` columns on `users` onto the table, then DROP those 22 columns.
Channels become uniform peers — adding one is just rows.

## The 22 columns (dropped)

- `daily_digest_include_{prices,top_movers}_{email,sms}` (4)
- `daily_digest_include_{news,rumors}_email` (email-only) (2)
- `asset_events_include_{calendar,ipo,analyst,insider}_{email,sms}` (8)
- `market_asset_price_alerts_include_{email,sms}` (2)
- `market_scheduled_asset_price_include_{email,sms}` (2)
- `price_move_alerts_include_{email,sms}` (2)
- `price_targets_include_{email,sms}` (2)

Default values (carried into the new-user default rows):

- `daily_digest prices email` = true, `daily_digest prices sms` = true
- ALL OTHER 20 = false

## KEPT columns (channel/feature level)

`email_notifications_enabled`, `sms_notifications_enabled`, `sms_opted_out`,
`telegram_chat_id/telegram_opted_out/telegram_id/telegram_linked_at`,
`market_asset_price_alerts_enabled`, `market_scheduled_asset_price_enabled`, `phone_*`.

Eligibility stays: global-enable column AND ≥1 per-option row in the table.

## Design

A `notification_preferences` row is `(user_id, notification_type, content, channel, enabled)`.

- Generalize the telegram-only eligibility helpers in `src/lib/messaging/notification-prefs.ts`
  to be channel-parametric: `isFacetEnabled(prefs, type, content, channel)`,
  `enabledFacets(prefs, type, channel)`, `anyChannelFacetEnabled(...)`.
- `UserRecord` (and the narrower per-flow user shapes) carry a `prefs: PrefRow[]` array
  loaded once per user, replacing the 22 columns. Each read site looks up `user.prefs`.
- Eligibility = KEPT global enable (e.g. `email_notifications_enabled`) AND ≥1 enabled
  facet row for the type+channel.

### `.or()` fan-out filters (cannot reference a second table)

- daily-digest `query.ts` / `query-upcoming.ts`: the `.or()` already only references KEPT
  columns (`email_notifications_enabled`/`sms_notifications_enabled`). Only the SELECT
  projection drops the 22 columns. Per-user prefs are loaded in a batch after the fetch.
- asset-events `query.ts`: `ASSET_EVENTS_ENABLED_OR` + `HAS_DELIVERY_CHANNEL_OR` embed the
  dropped columns. REDESIGN: fetch candidate users gated by KEPT columns only, then load
  their prefs in a batch and filter in code (asset_events facet enabled for an enabled
  channel, and not handled by the daily pipeline).
- scheduled `select.ts`: `HAS_DELIVERY_CHANNEL_OR` embeds `market_scheduled_asset_price_include_*`.
  REDESIGN: candidate filter = `market_scheduled_asset_price_enabled` + global channel enable;
  load prefs in a batch; filter to users with the scheduled facet enabled for an enabled channel.
- `fetchPriceAlertUsers` / `fetchFlatPriceAlertUsers`: `.or()` embeds the dropped columns +
  telegram_chat_id. REDESIGN: candidate filter on KEPT columns
  (`market_asset_price_alerts_enabled` / email+sms global enables / telegram linked); load
  prefs in a batch; the delivery loop already re-checks per-option, so just attach `prefs`.
- `price-targets process.ts`: `.in("id", userIds)` is keyed by the price_targets join, not the
  22 columns; just drop the 22 columns from the projection and attach prefs.

### Writes

- `notification-preferences-telegram.ts` → generalize to write ALL submitted channels' rows
  (email/sms/telegram), not just telegram. `update.ts` keeps writing KEPT columns to `users`,
  and now writes email/sms/telegram facet rows to the table.
- Signup (`register.ts`): insert default `notification_preferences` rows for the new user
  (prices email+sms = true, everything else false) for email + sms channels.

### Migration

New migration drops the 22 columns. Ordering: the 180556 migration already backfilled
email/sms rows from the columns; dual-write + signup defaults keep them current; so the table
holds the data before the drop. Bump `app_metadata.schema_version` +
`EXPECTED_DB_SCHEMA_VERSION`.

### UI

dashboard.astro builds email/sms facet maps from the table (like telegram) and passes them to
the Vue panels alongside the telegram maps. Panels init email/sms refs from the maps (mirrors
telegram). current.ts / update.ts translate table rows ↔ the snapshot the UI already uses.

## Verify

`check:ts`, `biome check --write`, `check:knip`, `db:reset`, `build`, full `npm test`.
