## Purpose
This file captures the non-negotiables for this repo. It is a new app, so we optimize for long-term simplicity and correctness over backwards compatibility.

## Principles & Standards

### Core principles
- **Refactor-first over compatibility**: Prefer aggressively simplifying redesigns, even if breaking. Remove legacy code instead of preserving it. Do not keep backwards compatibility when it increases complexity.
- **Demand specificity**: Refuse to proceed without concrete, measurable requirements and clear acceptance criteria.

### Coding standards
- **Compatibility**
  - **No compatibility layers**: Avoid shims, adapters, deprecations, or re-exports for legacy behavior.
  - **No browser polyfills or legacy fallbacks**: Don't add try-catch blocks, feature detection, or polyfills for old browsers (IE11, etc.). Modern browser APIs like `fetch`, `URL`, `AbortController`, `TextEncoder`/`TextDecoder`, `crypto.randomUUID()`, etc. are well-supported and generally won't throw in supported environments. Only handle legitimate error cases (e.g., `sessionStorage` throwing `SecurityError` in private browsing modes). Server-side polyfills (e.g., `@js-temporal/polyfill` for Node.js) are acceptable when the API isn't available in the runtime environment.
- **Code structure**
  - **Keep files focused**: ≤300 lines; extract utilities to maintain DRY principles.
  - **Prefer functional patterns**: Use classes only when clearly warranted; question class-based approaches.
  - **Avoid one-line functions**: Either inline simple logic or expand to meaningful functions.
  - **Self-documenting code**: Write clear, descriptive names and structure; avoid TSDoc/JSDoc comments.
  - **Comment deviations from guidelines**: When implementing code that appears to contradict these guidelines (e.g., trimming third-party webhook input, adding a compatibility layer), add an inline comment explaining why the deviation is necessary and justified.
  - **DRY principle**: Check for similar code in other files before implementing; extract shared logic to utilities.
- **Imports**
  - **Clean imports**: Use relative paths (not '@' style); delete unused imports.
- **Errors**
  - **Error handling**: Let errors propagate naturally; avoid defensive programming when the type system/constraints guarantee safety (e.g., strict TypeScript, non-nullable DB columns). Add null/undefined checks when values can legitimately be missing (e.g., parsed JSON, nullable columns, third-party payloads). Handle errors at boundaries (API endpoints, user-facing code) where appropriate.
  - **Deterministic error checking**: Avoid using `.includes()` or other string matching methods to detect error types. Use structured error properties (e.g., `error.code`, `error.status`) or verify conditions before operations (e.g., verify captcha tokens before API calls) rather than parsing error messages.
  - **Avoid fallbacks in error scenarios**: Don't use silent fallbacks or default values when encountering unexpected conditions or errors. Fail fast and explicitly. If you *must* introduce a fallback/retry for operational resilience, make it intentional and observable: gate it on structured error properties (e.g., `error.code`/`error.status`) and log it with enough context to diagnose production behavior.
  - **Environment variable validation**: Do NOT add presence checks for required environment variables in source files. All required env vars are validated in `src/middleware.ts` on every request. Only validate format/type (e.g., `RESEND_API_KEY` must start with "re_") or handle optional env vars (e.g., `EMAIL_REPLY_TO`, `TIMEZONE_CACHE_BUSTER`).
- **Logging**
  - **Log unexpected redirects**: When a user is redirected due to an error or unexpected condition, log the error with context (user ID, path, reason) to help diagnose issues in production.
  - **Structured logger**: Use `src/lib/logging.ts` (`createLogger`, `logInfo`, `logWarn`, `logError`) which writes JSON entries to `console.*` with `timestamp`, `level`, `message`, optional `context`, and optional `error` (serialized). `requestId` is lifted out of context into its own top-level field.
  - **PII masking**: All string fields in log output are passed through `safeJsonStringify`, which masks email/phone patterns when `LOG_MASK_PII` is unset/empty or not `"false"` (default ON). This also handles bigint, Error serialization, and circular references.
- **Validation & normalization**
  - **Validation**: Minimize trimming/normalization. All client/user input is untrusted; front-end validation is UX-only. Prefer enforcing correctness via database constraints (the primary integrity layer) and handling constraint failures at boundaries; only add application-level validation when inputs do not flow through a constrained database write (e.g., third-party webhooks).
  - **Trust database values**: Do not add defensive checks (null checks, type checks, fallback values) for data coming from the database when schema constraints guarantee correctness. NOT NULL columns will have values; CHECK constraints ensure valid ranges; foreign keys ensure referential integrity. Supabase query results return arrays (never null) on success. Use type assertions when TypeScript types don't reflect query filters (e.g., `user.next_send_at as string` after filtering out nulls).
  - **External service data normalization**: When passing data to external services that don't enforce our database constraints (e.g., Supabase Auth's `auth.users` table), trim/normalize at the application level before sending. Add comments explaining why this cannot be enforced at the DB level (because the external service owns its storage/constraints). This prevents mismatches between external service data and our database constraints.
- **Timing**
  - **Timing hacks**: Avoid setTimeout, nextTick, requestAnimationFrame, and similar timing workarounds. These are usually signs of race conditions or architectural issues. Fix the root cause instead of adding delays.

## Development Approach
- **Start simple**: Design from first principles; add complexity only as needed.
- **Clarify ambiguity**: Ask up to 3 targeted questions about scope, constraints, and edge cases.
- **Offer alternatives**: Provide 2-3 approaches with pros/cons and a recommendation with justification.

## Repo Constraints
- **Database migrations**: Do NOT create new migration files. Only modify the initial migration in `supabase/migrations`. This is a new app with no users, so destructive schema changes are OK.
- **Generated files**: Do NOT modify `src/lib/db/generated/database.types.ts` directly. This file is auto-generated from the Supabase schema. If type issues arise, use type assertions in application code or regenerate the types using the Supabase CLI.

## Supabase Auth
- **Email identity provider_id**: For email providers in `auth.identities`, `provider_id` must be set to the user's UUID from `auth.users`, NOT the email address. For OAuth/SAML providers, `provider_id` uses the provider's unique ID. This is a critical requirement—using the email for email providers will break authentication.
- **CAPTCHA + resend verification (supabase-js v2.90.0)**: `supabase.auth.resend(...)` supports `options.captchaToken`. When CAPTCHA verification fails, Supabase may return `error.code === "captcha_failed"` (see `src/pages/api/auth/email/resend-verification.ts`).

## Tech Stack
- **Testing**: Vitest only; happy path coverage only. Do not use Jest.
- **Linting/Formatting**: Biome only (No Prettier or ESLint)
- **Styling**: Tailwind utilities preferred over custom CSS

## Export Pattern
- Functions: `export function name(...)` directly where defined
- Classes: Define first, then `export { ClassName }` at bottom

## Section Comments
```txt
/* =============
Comment Title
============= */
```