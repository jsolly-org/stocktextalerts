## Purpose
This file captures test-specific rules and guidance for this repo. Tests use the real Supabase client and seeded data where possible; mocks are kept minimal and focused on outbound side effects only.

## Testing Framework
- **Vitest only**: Use Vitest for all tests. Do not use Jest.
- **Happy path coverage only**: Focus on success paths and essential validation; avoid exhaustive edge-case coverage that increases maintenance cost. Exceptions: security tests may keep negative-path cases when they validate rejection of invalid input (e.g. `tests/security/forgot-password-security.test.ts` describe "A user requests a password reset email from the forgot password form." / it "The request is rejected when the form is incomplete.").

## Mocking
- **Integration over isolation**: Prefer integration tests that use real dependencies. Only mock external services that consume paid API allocations (e.g., Resend, Twilio, Finhub). Everything else — including local Supabase/Postgres — should be real.
- **Do not mock Supabase**: Do not use `vi.mock()` (or similar) on `src/lib/db/supabase` or Supabase client modules. Route tests through the real Supabase client and seeded data using existing helpers (e.g. `createTestUser`, `adminClient`, `shared-utils`).
- **Shared stubs**: Consolidate reusable notification stubs in `tests/shared-utils.ts` and reset between tests so mocks stay minimal and consistent.

## Assertions
- **Assert via behavior, not mocks**: Prefer asserting on DB state, response payloads, and status codes rather than on mocked return values or call counts of Supabase methods.
- **Delivery-related tests**: For flows that trigger notifications, assert "send attempted" or outcome via stub invocation counts, log rows, or response payloads—not real API responses or API keys.

## Test Structure
- **Use shared utilities**: Reuse helpers from `tests/shared-utils.ts` (and domain-specific utils like `tests/stocks/utils.ts`) to keep tests DRY and setup consistent.
- **Setup/teardown**: Rely on `tests/setup.ts` for global hooks (schema verification, cleanup, console spies). Use `registerTestUserForCleanup` for users created during a test so they are cleaned up after each test.
- **Console output**: `setup.ts` asserts no unexpected `console.warn` or `console.error`. Use `allowConsoleWarnings()` / `allowConsoleErrors()` when a test intentionally triggers those; call `resetConsoleAssertions()` in shared helpers if needed.

## Determinism and Environment
- **No timing hacks**: Avoid `setTimeout`, `nextTick`, or artificial delays to paper over races; fix the test or production code so behavior is deterministic.
- **Environment**: Tests run against the Supabase instance configured in the test environment (e.g. local emulator). The setup mocks `getSiteUrl` via `src/lib/db/env` to a test host; required env vars are validated in `src/middleware.ts` (or test setup). Do not add extra env presence checks in test files.

## Section Comments
When organizing larger test files, use the same section comment style as the rest of the repo. Single-line section headers:
```txt
/* ============= Section Title ============= */
```
