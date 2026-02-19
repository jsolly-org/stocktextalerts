## Testing Guidelines

### Framework
- **Vitest only**: Do not use Jest.
- **Happy path coverage only**: Focus on success paths and essential validation; avoid exhaustive edge-case coverage. Exception: security tests (`.security.test.ts` suffix) may keep negative-path cases for validating rejection of invalid input.

### Mocking
- **Integration over isolation**: Prefer integration tests that use real dependencies. Only mock external services that consume paid API allocations (e.g., Resend, Twilio, Finnhub).
- **Do not mock Supabase**: Route tests through the real Supabase client and seeded data using helpers (`createTestUser` from `test-user.ts`, `adminClient` from `test-env.ts`).

### Assertions
- **Assert via behavior, not mocks**: Prefer asserting on DB state, response payloads, and status codes rather than on mocked return values or call counts.
- **Delivery-related tests**: Assert "send attempted" or outcome via stub invocation counts, log rows, or response payloads — not real API responses.

### Test Style
- **Scenario-based, grounded in reality**: Every test should read like a real scenario that could happen in production. Frame `describe`/`it` blocks around user journeys or system events, not abstract technical operations.
  - Good: `"User in Pacific timezone receives market update after close"`
  - Bad: `"returns correct value when input is 2"`
- **Realistic data**: Use real ticker symbols (AAPL, MSFT, SPY), realistic prices, real timezone names (America/New_York), and plausible user details. Never use placeholder values like `foo`, `bar`, `test123`, or round-number prices (100.0) when a realistic value (187.42) would work.
- **Test builders should reflect reality**: When helpers like `makeQuote()` or `makeSnapshot()` supply defaults, those defaults should be realistic values, not abstract round numbers.

### Test Structure
- **Use shared utilities**: Reuse helpers from `tests/helpers/` (`test-user.ts`, `test-env.ts`, `asset-data.ts`, `asset-update.ts`). Import from the defining module.
- **Setup/teardown**: Rely on `tests/setup.ts` for global hooks (schema verification, cleanup, console spies). Use `registerTestUserForCleanup` for users created during a test.
- **Console output**: `setup.ts` asserts no unexpected `console.warn` or `console.error`. Use `allowConsoleWarnings()` / `allowConsoleErrors()` when a test intentionally triggers those; call `resetConsoleAssertions()` in shared helpers if needed.

### Environment
- Tests run against the Supabase instance configured in the test environment (local emulator). The setup mocks `getSiteUrl` via `src/lib/db/env` to a test host.
- Do not add extra env presence checks in test files — `src/middleware.ts` handles this.
- No `setTimeout`/`nextTick`/artificial delays to paper over races; fix the root cause.

### Running Tests
- **Always use `npm test`** — never `npx vitest run` directly. The `npm test` script uses `node --env-file-if-exists=.env.local` to load required Supabase environment variables (`SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SUPABASE_PUBLISHABLE_KEY`, `DATABASE_URL`). Running vitest directly will fail with `supabaseUrl is required`.
- **Local Supabase must be running**: Start with `npx supabase start` before running tests. After a `supabase db reset`, also restart with `npx supabase stop && npx supabase start` to refresh the PostgREST schema cache.
- **Schema version**: When adding migrations, update the schema version in the migration SQL (`app_metadata.schema_version`) and the expected version in `tests/helpers/constants.ts` (`EXPECTED_DB_SCHEMA_VERSION`). Tests will fail with a schema mismatch error if these are out of sync.

### Linting
- This project does not use ESLint or Prettier. There is no lint script in `package.json`.
- Use `npx tsc --noEmit` for TypeScript checking and `npx vue-tsc --noEmit` for Vue component type checking.
