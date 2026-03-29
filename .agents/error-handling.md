## Error Handling & Validation

### Error Handling
- **Trust the type system**: Skip defensive null/undefined checks when strict TypeScript or DB constraints guarantee safety. Add checks only when values can legitimately be missing (parsed JSON, nullable columns, third-party payloads).
- **Deterministic error checking**: Use structured error properties (`error.code`, `error.status`), not string matching (`.includes()`) on messages.
- **Fail fast**: No silent fallbacks or default values on unexpected errors. If a fallback is needed for resilience, gate it on structured error properties and log with context.
- **Env var validation**: Use `requireEnv()` from `src/lib/db/env.ts` at point-of-use for required env vars. Only validate format/type beyond presence checks.

### Validation & Normalization
- **Database is the integrity layer**: Enforce correctness via DB constraints; handle constraint failures at boundaries. Front-end validation is UX-only.
- **Trust database values**: Don't add null checks or fallbacks for NOT NULL columns, CHECK constraints, or FK-guaranteed data. Supabase queries return arrays (never null) on success. Use type assertions when TS types don't reflect query filters (e.g., `user.next_send_at as string`).
- **Normalize for external services only**: Trim/normalize data going to services that don't enforce our constraints (e.g., Supabase Auth's `auth.users`). Comment why.

### Logging
- Use `src/lib/logging.ts` (`createLogger`, `logInfo`, `logWarn`, `logError`) — structured JSON to `console.*` with `timestamp`, `level`, `message`, `context`, optional `error`. `requestId` is a top-level field.
- **Always pass a named context object** (no `{}`/`undefined`).
- **Expected rejections (auth failures, invalid input, rate limits) → `info`**, not `warn`/`error`. Reserve `warn`/`error` for genuine failures (DB errors, service outages).
- **Log unexpected redirects** with user ID, path, and reason.
- **PII masking** is automatic via `safeJsonStringify` (masks email/phone) when `LOG_MASK_PII` ≠ `"false"`.
