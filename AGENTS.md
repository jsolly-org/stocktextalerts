## Core Principles
- **Refactor-first over compatibility**: Prefer clean redesigns that simplify the system, even if breaking. Remove legacy code instead of preserving it.
- **Demand specificity**: Refuse to proceed without concrete, measurable requirements and clear acceptance criteria.

## Development Approach
- **Start simple**: Design from first principles; add complexity only as needed.
- **Clarify ambiguity**: Ask up to 3 targeted questions about scope, constraints, and edge cases.
- **Offer alternatives**: Provide 2-3 approaches with pros/cons and a recommendation with justification.
- **Database migrations**: Do NOT create new migration files. Only modify the initial migration in `supabase/migrations`. This is a new app with no users, so destructive schema changes are OK.
- **Generated files**: Do NOT modify `src/lib/generated/database.types.ts` directly. This file is auto-generated from the Supabase schema. If type issues arise, use type assertions in application code or regenerate the types using the Supabase CLI.

## Supabase Auth
- **Email identity provider_id**: For email providers in `auth.identities`, `provider_id` must be set to the user's UUID from `auth.users`, NOT the email address. For OAuth/SAML providers, `provider_id` uses the provider's unique ID. This is a critical requirement—using the email for email providers will break authentication.
- **CAPTCHA + resend verification (supabase-js v2.90.0)**: `supabase.auth.resend(...)` supports `options.captchaToken`. When CAPTCHA verification fails, Supabase may return `error.code === "captcha_failed"` (see `src/pages/api/auth/email/resend-verification.ts`).

## Coding Standards
- **No compatibility layers**: Avoid shims, adapters, deprecations, or re-exports for legacy behavior.
- **No browser polyfills or legacy fallbacks**: Don't add try-catch blocks, feature detection, or polyfills for old browsers (IE11, etc.). Modern browser APIs like `Intl.DateTimeFormat().resolvedOptions().timeZone`, `sessionStorage`, `Map`, `Set`, etc. are well-supported and won't throw in supported environments. Only handle legitimate error cases (e.g., `sessionStorage` throwing `SecurityError` in private browsing modes). Server-side polyfills (e.g., `@js-temporal/polyfill` for Node.js) are acceptable when the API isn't available in the runtime environment.
- **Keep files focused**: ≤300 lines; extract utilities to maintain DRY principles.
- **Prefer functional patterns**: Use classes only when clearly warranted; question class-based approaches.
- **Avoid one-line functions**: Either inline simple logic or expand to meaningful functions.
- **Clean imports**: Use relative paths (not '@' style); delete unused imports; no re-exports for compatibility.
- **Self-documenting code**: Write clear, descriptive names and structure; avoid TSDoc/JSDoc comments.
- **DRY principle**: Check for similar code in other files before implementing; extract shared logic to utilities.
- **Error handling**: Let errors propagate naturally; avoid defensive programming (unnecessary null checks, try-catch blocks that swallow errors). Handle errors at boundaries (API endpoints, user-facing code) where appropriate.
- **Deterministic error checking**: Avoid using `.includes()` or other string matching methods to detect error types. Use structured error properties (e.g., `error.code`, `error.status`) or verify conditions before operations (e.g., verify captcha tokens before API calls) rather than parsing error messages.
- **Avoid fallbacks in error scenarios**: Don't use fallbacks or default values when encountering unexpected conditions or errors. Fail fast and explicitly. It's better to discover issues early than to have fault-tolerant code that masks problems.
- **Log unexpected redirects**: When a user is redirected due to an error or unexpected condition, log the error with context (user ID, path, reason) to help diagnose issues in production.
- **PII logging**: Do not mask or omit PII (personally identifiable information) in logs. Log email addresses, phone numbers, and other identifiers as needed for debugging and error tracking.
- **Validation**: Minimize trimming/normalization. Rely on strict front-end forms/inputs to produce valid data, then validate/enforce correctness in the database (constraints). Only validate untrusted external input.
- **External service data normalization**: When passing data to external services that don't enforce our database constraints (e.g., Supabase Auth's `auth.users` table), trim/normalize at the application level before sending. Add comments explaining why this cannot be enforced at the database level. This prevents mismatches between external service data and our database constraints.
- **Timing hacks**: Avoid setTimeout, nextTick, requestAnimationFrame, and similar timing workarounds. These are usually signs of race conditions or architectural issues. Fix the root cause instead of adding delays.

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