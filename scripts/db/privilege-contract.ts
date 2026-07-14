/**
 * scripts/db/privilege-contract.ts — the explicit source of truth for which
 * PostgREST-exposed (`.rpc(...)`) Supabase functions each client role may
 * EXECUTE.
 *
 * Why this exists: local `db:reset` historically applied
 * `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON FUNCTIONS TO anon, authenticated,
 * service_role`, so every function was executable by every role locally. Hosted
 * production has empty `public` default privileges, so a function that forgot an
 * explicit `GRANT EXECUTE ... TO service_role` (or that accidentally left a
 * client-role grant in place) behaved differently in prod than in tests. That
 * gap is exactly what let the duplicate-SMS incident ship: the delivery-state
 * RPCs were executable locally but `service_role` could not call them in prod.
 *
 * Keep this list EXPLICIT rather than inferred from code. Security intent should
 * be reviewed in diffs, not derived at runtime. Every function the app calls via
 * `supabase.rpc(...)` MUST appear in `RPC_PRIVILEGES`. Every other app-owned
 * (non-extension) function in `public` MUST appear in `INTERNAL_FUNCTIONS`. The
 * checker (`scripts/db/check-privileges.ts`) fails if it finds an app-owned
 * function that is in neither list, which forces classification of new RPCs.
 *
 * Each entry carries a single `class`; the EXECUTE roles it implies are derived
 * from that class via `EXECUTE_BY_CLASS` / `executeRolesFor`. There is no
 * hand-written role list per entry, so a contributor cannot accidentally pair a
 * `server-only` classification with a client-role grant — the exact misgrant
 * this file exists to prevent.
 *
 * Signatures use the `pg_get_function_identity_arguments` form, i.e. exactly
 * what `SELECT proname || '(' || pg_get_function_identity_arguments(oid) || ')'`
 * returns. That keeps matching against `pg_proc` unambiguous when overloads or
 * default arguments are involved.
 */

export type RoleName = "anon" | "authenticated" | "service_role";

/** Every client role the checker probes for EXECUTE. */
export const CLIENT_ROLES: RoleName[] = ["anon", "authenticated", "service_role"];

/**
 * Classification of an app-called RPC:
 *
 * - `server-only`: only `service_role` may execute. Invoked by Lambda/cron/admin
 *   code paths using the secret key. `anon`/`authenticated` EXECUTE is a bug.
 * - `authenticated-client`: `authenticated` (browser/session) plus `service_role`
 *   (server repair paths). The function MUST enforce `auth.uid()` / role
 *   internally; the grant alone is not the authorization boundary.
 */
export type RpcClass = "server-only" | "authenticated-client";

/** The EXECUTE roles each class implies — the single source of role truth. */
const EXECUTE_BY_CLASS: Record<RpcClass, RoleName[]> = {
	"server-only": ["service_role"],
	"authenticated-client": ["authenticated", "service_role"],
};

export type RpcPrivilege = {
	/** `proname(pg_get_function_identity_arguments)` — must match pg_proc exactly. */
	signature: string;
	class: RpcClass;
	/** Why this classification — reviewed in diffs. */
	reason: string;
};

/** Roles expected to hold EXECUTE for an entry, derived from its `class`. */
export function executeRolesFor(entry: Pick<RpcPrivilege, "class">): RoleName[] {
	return EXECUTE_BY_CLASS[entry.class];
}

/**
 * Every function reachable via `supabase.rpc(...)` in `src/`.
 *
 * Audited against `src/**` on 2026-06-08:
 *   - server-only callers use the secret-key admin client (Lambda/cron/handlers)
 *   - authenticated-client callers run on a session-scoped client (API routes)
 */
export const RPC_PRIVILEGES: RpcPrivilege[] = [
	// --- Delivery-state RPCs (the incident surface) -------------------------
	{
		signature: "reserve_flat_price_alert(p_user_id uuid, p_symbol text, p_baseline_price numeric, p_new_price numeric, p_threshold_value numeric, p_threshold_unit text)",
		class: "server-only",
		reason: "Schedule Lambda claims a flat-price-alert delivery slot",
	},
	{
		signature: "finalize_flat_price_alert(p_user_id uuid, p_symbol text)",
		class: "server-only",
		reason: "Schedule Lambda finalizes a flat-price-alert delivery slot after send",
	},
	{
		signature: "release_flat_price_alert(p_user_id uuid, p_symbol text)",
		class: "server-only",
		reason: "Schedule Lambda releases a flat-price-alert slot on send failure",
	},
	{
		signature: "claim_scheduled_notification(p_user_id uuid, p_notification_type scheduled_notification_type, p_scheduled_date date, p_scheduled_minutes integer, p_channel delivery_method)",
		class: "server-only",
		reason: "Schedule Lambda claims a digest/scheduled-notification delivery slot",
	},
	{
		signature: "claim_email_dispatch_key(p_key text)",
		class: "server-only",
		reason: "Email-dispatch Lambda claims an idempotency key (with expired-key reclaim)",
	},
	{
		signature: "try_consume_notification_budget(p_user_id uuid, p_kind text, p_count integer)",
		class: "server-only",
		reason: "Schedule Lambda reserves per-user ET-day notification volume before send",
	},
	{
		signature: "release_notification_budget(p_user_id uuid, p_kind text, p_count integer)",
		class: "server-only",
		reason: "Schedule Lambda refunds a reserved notification-budget unit on send failure",
	},
	// --- Maintenance / purge RPCs (server cron only) ------------------------
	{
		signature: "purge_expired_email_dispatch_keys()",
		class: "server-only",
		reason: "Schedule handler purges expired email-dispatch idempotency keys",
	},
	{
		signature: "purge_old_asset_price_history(p_retention_hours integer)",
		class: "server-only",
		reason: "Price-history cache maintenance (server)",
	},
	{
		signature: "purge_old_asset_daily_closes(p_retention_days integer)",
		class: "server-only",
		reason: "Daily-close cache maintenance (server)",
	},
	{
		signature: "purge_old_prediction_market_odds(p_retention_days integer)",
		class: "server-only",
		reason: "Prediction-market odds cache maintenance (server)",
	},
	// --- Auth rate limiting (server admin client) ---------------------------
	{
		signature: "check_rate_limit(p_user_id uuid, p_endpoint text, p_max_requests integer, p_window_minutes integer)",
		class: "server-only",
		reason: "API routes call this through the secret-key admin client to gate auth endpoints",
	},
	// --- Authenticated client RPCs (session-scoped, guarded by auth.uid()) ---
	{
		signature: "replace_user_assets(user_id uuid, symbols text[])",
		class: "authenticated-client",
		reason: "Dashboard updates the signed-in user's tracked assets; enforces auth.uid() internally",
	},
];

/**
 * App-owned (`postgres`-owned, non-extension) `public` functions that are NOT
 * reachable via the Data API in normal operation: trigger functions, CHECK /
 * domain helpers, and RLS helper functions.
 *
 * These are listed so the checker can distinguish "known internal helper" from
 * "unclassified new function". The checker does NOT enforce a specific EXECUTE
 * shape on them in the first pass:
 *   - Trigger functions: Postgres does not check EXECUTE when firing triggers.
 *   - CHECK/RLS helper functions: tightening these has subtle evaluation-time
 *     semantics and is deliberately out of scope here (see the plan's "Open
 *     Risk"). Revisit if any of these is ever exposed via `.rpc(...)`.
 *
 * Legacy `claim_*` functions are intentionally NOT here — they predate the
 * reserve/finalize split and are no longer called from `src/`, but remain
 * PostgREST-exposed claim functions that accept a `p_user_id`. They are
 * classified as `server-only` and tightened by the migration. They live in
 * `LEGACY_SERVER_ONLY` below.
 */
export const INTERNAL_FUNCTIONS: string[] = [
	"handle_auth_user_deleted()",
	"has_no_whitespace(value text)",
	"is_approved()",
	"is_valid_market_scheduled_asset_price_times(times integer[])",
	"prevent_user_approval_self_change()",
	"update_updated_at_column()",
];

/**
 * Superseded `claim_*` delivery RPCs. No longer called from `src/` (replaced by
 * reserve/finalize/release), but still present and PostgREST-exposed. They take
 * a `p_user_id` and perform privileged claims, so client roles must not execute
 * them. Treated as `server-only` by the checker and tightened by the migration.
 */
export const LEGACY_SERVER_ONLY: RpcPrivilege[] = [
	{
		signature: "claim_flat_price_alert(p_user_id uuid, p_symbol text, p_baseline_price numeric, p_new_price numeric, p_threshold_percent numeric)",
		class: "server-only",
		reason: "Legacy flat-price-alert claim, superseded by reserve/finalize; no client access",
	},
];

/** All functions the checker holds to an explicit EXECUTE shape. */
export const ENFORCED_FUNCTIONS: RpcPrivilege[] = [...RPC_PRIVILEGES, ...LEGACY_SERVER_ONLY];
