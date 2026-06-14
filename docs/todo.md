# Follow-ups

Items deferred from completed work. Each entry: short context + when it surfaced. Pick up when the relevant adjacent work is fresh in mind.

## Status-message live regions (surfaced 2026-06-14)

Context: made the save-status live regions announce reliably. The reactive cases now render the box inside a **caller-owned, always-mounted, static** live region (fixed `role="status" aria-live="polite"`) so a later change announces and the politeness never re-races the text — `StatusMessage.vue` gained a `live="false"` mode (box only, no own region) for use inside such a region. Converted: `TimeFormatSection`/`TimezoneSection` (save-status) and `WatchlistPanel`/`NotificationChannelsPanel` (flash lists). Residual items:

- [ ] **Remaining `v-if`-gated `StatusMessage.vue` usages still insert-then-announce.** Out of scope for the reactive-cases pass, but a few appear/change *after* mount and could miss announcement: `TimezoneMismatchBanner.vue` (`v-if="isClient && isVisible"`), `SmsCodeVerification.vue` (the `isExpired` timer flip, ×2), `ScheduledUpdateControls.vue` (`v-if="maxTimesReached"`), `NotificationChannelsFieldset.vue` (`v-if="props.smsOptedOut"`), and `TimezoneSection.vue`'s `v-if="timezoneLoadError"`. These keep `StatusMessage`'s self-contained `live=true` region (tone fixed for their lifetime, so role/aria-live are correct at insertion — no in-place mutation), but the region is still inserted *with* its text, so an appearance after mount may not be announced. Give the genuinely-post-mount ones (mismatch banner, code-expiry) the caller-owned-static-region treatment if AT coverage matters there. The `.astro` pages use a separate server-rendered `StatusMessage.astro` and are not affected.
- [ ] **`WatchlistPanel.vue` save-status badge (lines ~4-21) is a `v-if`-gated custom live region** (`v-if="statusMessage && statusTone === 'error'"`, `role="status" aria-live="polite"`, inside a `FadeTransition`) — not a `StatusMessage`, so it wasn't touched. Same insert-then-announce class: the error badge after a failed watchlist save may not be announced. Give it an always-mounted static region (mind the `FadeTransition` wrapper) if AT coverage there matters.
- [ ] **`scripts/db/worktree-supabase.ts` produces an invalid Supabase `project_id` for long branch names.** The id is built as the `stocktextalerts-wt-` prefix plus a `slug` that's clamped to 40 chars — but the prefix isn't counted, so a long worktree name (e.g. `worktree-status-live-region-announce`) yields a 55-char id that the Supabase CLI truncates to 40 chars ending in `-`, breaking `db:start` with `failed to parse filters … "all" is an invalid volume filter`. Clamp the **final** `projectId` (prefix included) to a valid length and strip any trailing `-`. Worked around this session by hand-editing the worktree's `config.toml` (a `skip-worktree` local file).

## Least-privilege / Twilio / live-checks (surfaced 2026-06-13)

Context: cutover of the SMS senders + Verify to a scoped Twilio Restricted API key, replacement of the `live-provider-tests.yml` GitHub Actions workflow with the `live-provider-check` Lambda, and the fleet least-privilege pass. Deploy is done and verified (senders carry only the Restricted key; webhook validators keep the Auth Token); these are the residual items.

### Done (2026-06-13 credential audit)

- [x] **Revoked the orphaned Twilio Standard key** `SKcff312531f34923a6acc3c115772959d` ("twilio-cli for johnsolly on Johns-MacBook-Air.local") — deleted via the Twilio REST API (HTTP 204). The account now holds only the two Restricted runtime keys: `SK4fac…` (stocktextalerts-runtime) and `SK5b29…` (misc-notifications-runtime).
- [x] **Vercel env confirmed** — `TWILIO_API_KEY_SID`+`TWILIO_API_KEY_SECRET` present on Production+Preview (added 20:27), `TWILIO_AUTH_TOKEN` retained (re-propagated 21:13). The 21:49 production deploy is *after* the env add, so prod Verify/OTP has the Restricted key (the code requires it — no Auth-Token fallback). Sibling Vercel projects (checkboxes/jsolly-website/georoids) carry **no** service keys.
- [x] **Smoke-tested `live-provider-check`** (`aws lambda invoke` → StatusCode 200, no FunctionError; logs show the check ran). Also confirmed the every-minute `schedule` sender is erroring-free for 30 min → Restricted Twilio key + Supabase secret + Massive/Finnhub all verified working in production.
- [x] **Verified both Twilio Restricted keys' scopes in the Console** (read-only): `stocktextalerts-runtime` = Verify ×2 (create+check) + Messaging ×1 (create); `misc-notifications-runtime` = Messaging ×2 (create + read-one, NOT list). Nothing else selected on either (no Voice/Lookup/IAM/Billing). Minimal and exact.
- [x] **Live tests pass** — `npm run test:live:all` → 919/919 (real Massive/Finnhub/Twilio/SES/xAI).
- [x] **Added scope-enforcement tests** (verify a key HAS what it should and LACKS what it shouldn't, against the real Twilio API; out-of-scope → HTTP 401/code 70051):
  - stocktextalerts: `tests/lib/live-twilio-scope.test.ts` (gated `--live=twilio`) — HAS Messaging/Verify create; LACKS Messaging read + Voice. 4/4 pass.
  - misc-notifications: `scripts/twilio-scope-check.ts` (`npm run test:live:twilio-scope`) — HAS Messaging create+read-one; LACKS Messaging list + Voice. 4/4 pass.
  - Supabase scope is already covered by `tests/lib/db/privileges.test.ts` (per-role `has_function_privilege` contract, positive+negative) + `audit:db-parity`. Massive/Finnhub keys have no granular scopes (nothing to assert negatively).

### Deployed

- [x] **SUPABASE_SECRET_KEY over-provisioning fixed AND DEPLOYED** (`npm run deploy:aws`, stack `stocktextalerts-crons` UPDATE_COMPLETE, no rollback). Moved `SUPABASE_URL`/`SUPABASE_SECRET_KEY` out of SAM `Globals` into the 5 functions that construct a Supabase client (schedule, asset-events, email-dispatch, compute-daily-stats, vendor-backfill). Verified post-deploy: `live-provider-check` + `backup-user-settings` no longer carry the secret; the other 5 retain it; schedule sender erroring-free after deploy.

### Optional / nits

- [ ] Rotate the Twilio account Auth Token (rotate-AND-repropagate to Vercel inbound + the misc-notifications `twilio-status-callback`, which both still validate webhooks with it). Only if exposure is suspected.

### New (from 2026-06-13 credential audit)

- [ ] **Supabase MCP is not read-only scoped** — the connected MCP exposes write tools (`apply_migration`, `create_project`, `execute_sql`, …). Per `rules/agent-cloud-access.md` it should run with `--read-only --project-ref=japesagairjvvuebzpvr --features=database,docs,debugging`. Same Phase-4 work as the cross-repo item below.
- [x] **Supabase legacy `anon` + `service_role` JWT keys confirmed DISABLED** (verified visually in the dashboard → Settings → API Keys → "Legacy anon, service_role API keys": the only action offered is "Re-enable JWT-based API keys", i.e. they're currently off). Modern publishable + secret keys are the sole active path.
- [x] **awesome-django-blog: AKIA *ID* redacted** in `docs/plans/2026-06-09-aws-clickops-to-iac.md` (was `AKIA2UC3…`, IAM user `awesome-django-blog-heroku`). Git history check: entered in one docs commit (`2e06e328`); the 40-char secret was **never** committed (ID alone can't authenticate). A separate session (the started chip) is also handling this.
- [x] **Rotated the `awesome-django-blog-heroku` AWS access key.** New key `AKIA2UC3FDVB4DMBXCZF` created → John set it in Heroku `blogthedata` config vars (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`) → verified: new key lists `s3://blogthedata` (media/, static/), `www.blogthedata.com` HTTP 200 with CloudFront static assets → old key `AKIA2UC3FDVB5TPQHWXE` (the exposed-ID one) deactivated then DELETED. IAM user now holds exactly one (new) key. The redacted doc + this rotation fully close the exposure.

### xAI / Grok (added to audit scope 2026-06-13)

- [x] **xAI live test uses the production key** — `test:live:xai` reads `XAI_API_KEY` from `.env.local`, which is byte-identical to the `stocktextalerts-schedule` Lambda's key. No skew; genuinely live. (Massive/Finnhub `test:live:data` likewise use the prod keys.)
- [x] **Shared xAI key split into per-app keys (old shared key deleted).** Was one `xai-gbPMnwPvLd…` "Default" key in both repos. Now: `stocktextalerts-grok` (all-endpoints — `/v1/responses` isn't an individually-scopable endpoint label; verified working via `test:live:xai` + clean schedule Lambda post-deploy) and `misc-notifications-images` (scoped to the **Image** endpoint only — matches `scripts/generate-outfit-images.ts` → `/v1/images/generations`). Both repos' `.env.local` repointed; ST Lambda repointed via the deploy above. Old "Default" key deleted in the xAI console.
  - [x] misc-notifications-images Image scope **verified enforced** against the live xAI API: Image endpoint authorized (HTTP 400 on empty body = reached handler), chat endpoint denied (HTTP 403 `permission-denied`: "Access to the chat endpoint is denied"). Note: xAI validates the request body before the scope check, so the negative probe needs a *valid* body to surface the 403 (unlike Twilio, which checks authz first).

### Cross-repo (tracked here for visibility; not stocktextalerts code)

- [ ] Confirm `stock-buyer` was intentionally removed from `~/code` — its credential-free pre-push gate was lost with the directory.
- [ ] Make each agent cloud path actually scoped/live (AWS hand-scoped read role + IAM Identity Center step-up; Supabase MCP `--read-only --project-ref --features`; Vercel per-project OAuth MCP; read-scoped Twilio Restricted key). Designed in `dotagents` → `docs/plans/2026-06-13-least-privilege-access-architecture.md` (Phase 4); not started.
