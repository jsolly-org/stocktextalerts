/**
 * Test files that cannot share the runner with other files.
 *
 * Everything else runs with `fileParallelism` on (see vitest.config.ts). These are the
 * measured exceptions, not a precaution: running the suite four-wide surfaced exactly two
 * failure families, reproduced across runs.
 *
 *   - The universe/delisting reconcile specs assert on absolute row counts of the shared
 *     `assets` table (e.g. `expect(result.newListingsInserted).toBe(4)`). Any fixture another
 *     worker inserts concurrently changes the count. Their subject IS the whole table, so
 *     namespacing symbols per worker would not fix them: they need the table to themselves.
 *   - The scheduler specs call `runScheduledNotifications({ supabase, logger })`, whose scope
 *     is "every user due at time T" (src/lib/schedule/run.ts). It therefore picks up users
 *     other workers created, and fails when their owner's `afterEach` deletes one mid-run
 *     (seen once as a `scheduled_notifications_user_id_fkey` violation). Scoping the call to
 *     one user would change what the test covers, so it gets the table to itself instead.
 *   - The flat-alerts process specs call `processFlatPriceAlerts`, whose scope is every
 *     enabled user with a threshold row. Global `alertsTriggered` / `emailsSent` totals then
 *     include other workers' fixtures (reproduced on CI as
 *     "Opposite-direction recovery still requires the full threshold" expecting 0 got 1).
 *
 * `tests/pages/http/**` used to be here too, as the largest entry (auth 10.0s + profile 8.7s
 * of a 39.5s serial pass, measured on CI job 91709170896). Its `TypeError: fetch failed` was
 * not really a port conflict: the shared dev server was started lazily by whichever worker
 * got there first and then stopped by the `afterAll` that tests/setup.ts registers for every
 * file, so any file finishing killed the server the others were using. Moving the server's
 * lifecycle to the run (tests/helpers/http/server.ts + the teardown in
 * tests/global-setup.ts) removed the conflict, and those files run in parallel now.
 *
 * Keep this list short. Prefer fixing a test's shared-state assumption to adding it here;
 * every entry is a file that no longer benefits from parallelism.
 */
export const SERIAL_TEST_GLOBS = [
	"tests/lib/assets/universe-reconcile.test.ts",
	"tests/lib/assets/delisting-sweep.test.ts",
	"tests/handlers/maintenance/asset-maintenance.test.ts",
	"tests/lib/schedule/run.test.ts",
	"tests/lib/schedule/daily-digest-closure-fanout.test.ts",
	"tests/lib/market-notifications/flat-alerts/process.test.ts",
];
