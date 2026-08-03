/**
 * Test files that cannot share the runner with other files.
 *
 * Everything else runs with `fileParallelism` on (see vitest.config.ts). These are the
 * measured exceptions, not a precaution: running the suite four-wide surfaced exactly two
 * failure families, reproduced across runs.
 *
 *   - `tests/pages/http/**` drives a single Astro dev server on a fixed port
 *     (tests/helpers/http/server.ts, port 4325). Two workers hitting it race on startup and
 *     shutdown, which shows up as `TypeError: fetch failed`.
 *   - The universe/delisting reconcile specs assert on absolute row counts of the shared
 *     `assets` table (e.g. `expect(result.newListingsInserted).toBe(4)`). Any fixture another
 *     worker inserts concurrently changes the count. Their subject IS the whole table, so
 *     namespacing symbols per worker would not fix them: they need the table to themselves.
 *   - The scheduler specs call `runScheduledNotifications({ supabase, logger })`, whose scope
 *     is "every user due at time T" (src/lib/schedule/run.ts). It therefore picks up users
 *     other workers created, and fails when their owner's `afterEach` deletes one mid-run
 *     (seen once as a `scheduled_notifications_user_id_fkey` violation). Scoping the call to
 *     one user would change what the test covers, so it gets the table to itself instead.
 *
 * Keep this list short. Prefer fixing a test's shared-state assumption to adding it here;
 * every entry is a file that no longer benefits from parallelism.
 */
export const SERIAL_TEST_GLOBS = [
	"tests/pages/http/**/*.test.ts",
	"tests/lib/assets/universe-reconcile.test.ts",
	"tests/lib/assets/delisting-sweep.test.ts",
	"tests/handlers/maintenance/asset-maintenance.test.ts",
	"tests/lib/schedule/run.test.ts",
	"tests/lib/schedule/daily-digest-closure-fanout.test.ts",
];
