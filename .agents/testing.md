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

### Test Structure
- **Use shared utilities**: Reuse helpers from `tests/helpers/` (`test-user.ts`, `test-env.ts`, `asset-data.ts`, `asset-update.ts`). Import from the defining module.
- **Setup/teardown**: Rely on `tests/setup.ts` for global hooks (schema verification, cleanup, console spies). Use `registerTestUserForCleanup` for users created during a test.
- **Console output**: `setup.ts` asserts no unexpected `console.warn` or `console.error`. Use `allowConsoleWarnings()` / `allowConsoleErrors()` when a test intentionally triggers those; call `resetConsoleAssertions()` in shared helpers if needed.

### Environment
- Tests run against the Supabase instance configured in the test environment (local emulator). The setup mocks `getSiteUrl` via `src/lib/db/env` to a test host.
- Do not add extra env presence checks in test files — `src/middleware.ts` handles this.
- No `setTimeout`/`nextTick`/artificial delays to paper over races; fix the root cause.
