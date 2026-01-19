## Purpose
This file captures the non-negotiables for this repo. It is a new app, so we optimize for long-term simplicity and correctness over backwards compatibility.

## Principles & Standards

### Core principles
- **Refactor-first over compatibility**: Prefer clean redesigns that simplify the system, even if breaking. Remove legacy code instead of preserving it. Do not keep backwards compatibility when it increases complexity.
- **Demand specificity**: Refuse to proceed without concrete, measurable requirements and clear acceptance criteria.

### Coding standards
- **Compatibility**
  - **No compatibility layers**: Avoid shims, adapters, deprecations, or re-exports for legacy behavior.
  - **No browser polyfills or legacy fallbacks**: Don't add try-catch blocks, feature detection, or polyfills for old browsers (IE11, etc.). Modern browser APIs like `fetch`, `URL`, `AbortController`, `TextEncoder`/`TextDecoder`, `crypto.randomUUID()`, etc. are well-supported and generally won't throw in supported environments. However, `Intl.DateTimeFormat().resolvedOptions().timeZone` may legitimately return `undefined`, so callers must handle `undefined` explicitly before relying on the value (prefer failing fast; only use an intentional default like `UTC` when the product behavior truly requires it). Only handle legitimate error cases (e.g., `sessionStorage` throwing `SecurityError` in private browsing modes). Server-side polyfills (e.g., `@js-temporal/polyfill` for Node.js) are acceptable when the API isn't available in the runtime environment.
- **Code structure**
  - **Keep files focused**: ≤300 lines; extract utilities to maintain DRY principles.
  - **Prefer functional patterns**: Use classes only when clearly warranted; question class-based approaches.
  - **Avoid one-line functions**: Either inline simple logic or expand to meaningful functions.
  - **Self-documenting code**: Write clear, descriptive names and structure; avoid TSDoc/JSDoc comments.
  - **DRY principle**: Check for similar code in other files before implementing; extract shared logic to utilities.
- **Imports**
  - **Clean imports**: Use relative paths (not '@' style); delete unused imports.
- **Errors**
  - **Error handling**: Let errors propagate naturally; avoid defensive programming when the type system/constraints guarantee safety (e.g., strict TypeScript, non-nullable DB columns). Add null/undefined checks when values can legitimately be missing (e.g., parsed JSON, nullable columns, third-party payloads). Handle errors at boundaries (API endpoints, user-facing code) where appropriate.
  - **Deterministic error checking**: Avoid using `.includes()` or other string matching methods to detect error types. Use structured error properties (e.g., `error.code`, `error.status`) or verify conditions before operations (e.g., verify captcha tokens before API calls) rather than parsing error messages.
  - **Avoid fallbacks in error scenarios**: Don't use silent fallbacks or default values when encountering unexpected conditions or errors. Fail fast and explicitly. If you *must* introduce a fallback/retry for operational resilience, make it intentional and observable: gate it on structured error properties (e.g., `error.code`/`error.status`) and log it with enough context to diagnose production behavior.
- **Logging**
  - **Log unexpected redirects**: When a user is redirected due to an error or unexpected condition, log the error with context (user ID, path, reason) to help diagnose issues in production.
  - **PII logging**: Do not mask or omit PII (personally identifiable information) in logs. Log email addresses, phone numbers, and other identifiers as needed for debugging and error tracking (ensure log access is restricted and retention is managed appropriately).
- **Validation & normalization**
  - **Validation**: Minimize trimming/normalization. All client/user input is untrusted; front-end validation is UX-only. Prefer enforcing correctness via database constraints (the primary integrity layer) and handling constraint failures at boundaries; only add application-level validation when inputs do not flow through a constrained database write (e.g., third-party webhooks).
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