## Purpose
This file captures the non-negotiables for this repo. It is a new app, so we optimize for long-term simplicity and correctness over backwards compatibility.

## Principles & Standards

### Core principles
- **Refactor-first over compatibility**: Prefer aggressively simplifying redesigns, even if breaking. Remove legacy code instead of preserving it. Do not keep backwards compatibility when it increases complexity.

### Coding standards
- **Compatibility**
  - **No compatibility layers**: Avoid shims, adapters, deprecations, or re-exports for legacy behavior.
  - **No browser polyfills or legacy fallbacks**: Don't add try-catch blocks, feature detection, or polyfills for old browsers (IE11, etc.). Modern browser APIs like `fetch`, `URL`, `AbortController`, `TextEncoder`/`TextDecoder`, `crypto.randomUUID()`, etc. are well-supported and generally won't throw in supported environments. Only handle legitimate error cases (e.g., `sessionStorage` throwing `SecurityError` in private browsing modes). Server-side polyfills (e.g., `@js-temporal/polyfill` for Node.js) are acceptable when the API isn't available in the runtime environment.
- **Code structure**
  - **No single-file folders**: Do not create a folder that contains only one file. Only create a folder when there are at least two files in it; otherwise keep the file in the parent directory.
  - **Keep files focused**: ≤300 lines; extract utilities to maintain DRY principles.
  - **Prefer functional patterns**: Use classes only when clearly warranted; question class-based approaches.
  - **Avoid one-line functions**: Either inline simple logic or expand to meaningful functions.
  - **Self-documenting code**: Write clear, descriptive names and structure; avoid TSDoc/JSDoc comments.
  - **Inline comments for non-obvious code**: Add inline comments when code is non-obvious or when it's important to clarify why a choice was made (e.g., architectural constraints, framework limitations, trade-offs). Focus on explaining the "why" (the constraint or reasoning) rather than restating what the code does. Examples: `?component` suffix required because Astro Icon cannot run in Vue; trimming third-party webhook input because external services don't enforce our database constraints.
  - **DRY principle**: Check for similar code in other files before implementing; extract shared logic to utilities.
  - **Avoid tuple/array indexing for types**: Don't use tuple indexing (e.g., `Parameters<T>[0]`, `ReturnType<T>[0]`) or array indexing to extract types. Prefer direct type annotations or utility types that express intent clearly. For example, use `export const POST: APIRoute = async ({ ... }) => {` instead of `export async function POST({ ... }: Parameters<APIRoute>[0]): Promise<Response> {`.
- **Imports**
  - **Clean imports**: Use relative paths (not '@' style); delete unused imports.
- **Errors**
  - **Error handling**: Let errors propagate naturally; avoid defensive programming when the type system/constraints guarantee safety (e.g., strict TypeScript, non-nullable DB columns). Add null/undefined checks when values can legitimately be missing (e.g., parsed JSON, nullable columns, third-party payloads). Handle errors at boundaries (API endpoints, user-facing code) where appropriate.
  - **Deterministic error checking**: Avoid using `.includes()` or other string matching methods to detect error types. Use structured error properties (e.g., `error.code`, `error.status`) or verify conditions before operations (e.g., verify captcha tokens before API calls) rather than parsing error messages.
  - **Avoid fallbacks in error scenarios**: Don't use silent fallbacks or default values when encountering unexpected conditions or errors. Fail fast and explicitly. If you *must* introduce a fallback/retry for operational resilience, make it intentional and observable: gate it on structured error properties (e.g., `error.code`/`error.status`) and log it with enough context to diagnose production behavior.
  - **Environment variable validation**: Do NOT add presence checks for required environment variables in source files. All required env vars are validated in `src/middleware.ts` on every request. Only validate format/type (e.g., `RESEND_API_KEY` must start with "re_") or handle optional env vars (e.g., `EMAIL_REPLY_TO`, `TIMEZONE_CACHE_BUSTER`).
- **Logging**
  - **Log unexpected redirects**: When a user is redirected due to an error or unexpected condition, log the error with context (user ID, path, reason) to help diagnose issues in production.
  - **Expected rejections use info, not warn/error**: Unauthenticated requests, invalid form submissions, captcha failures, rate limits, invalid/expired tokens, and similar validation or policy rejections are often bots, crawlers, or normal user mistakes. Log them at `info` so they don't inflate error metrics or clutter logs. Reserve `warn`/`error` for genuine failures (e.g. DB errors, external service failures). Do not "fix" these by upgrading to `error` or `warn`.
  - **Structured logger**: Use `src/lib/logging.ts` (`createLogger`, `logInfo`, `logWarn`, `logError`) which writes JSON entries to `console.*` with `timestamp`, `level`, `message`, optional `context`, and optional `error` (serialized). `requestId` is lifted out of context into its own top-level field.
  - **Named context objects**: Always pass a named context object for log calls (avoid `{}`/`undefined`/omitting context). Keep the error as the third argument to `error()` when available.
  - **PII masking**: All string fields in log output are passed through `safeJsonStringify`, which masks email/phone patterns when `LOG_MASK_PII` is unset/empty or not `"false"` (default ON). This also handles bigint, Error serialization, and circular references.
- **Validation & normalization**
  - **Validation**: Minimize trimming/normalization. All client/user input is untrusted; front-end validation is UX-only. Prefer enforcing correctness via database constraints (the primary integrity layer) and handling constraint failures at boundaries; only add application-level validation when inputs do not flow through a constrained database write (e.g., third-party webhooks).
  - **Trust database values**: Do not add defensive checks (null checks, type checks, fallback values) for data coming from the database when schema constraints guarantee correctness. NOT NULL columns will have values; CHECK constraints ensure valid ranges; foreign keys ensure referential integrity. Supabase query results return arrays (never null) on success. Use type assertions when TypeScript types don't reflect query filters (e.g., `user.next_send_at as string` after filtering out nulls).
  - **External service data normalization**: When passing data to external services that don't enforce our database constraints (e.g., Supabase Auth's `auth.users` table), trim/normalize at the application level before sending. Add comments explaining why this cannot be enforced at the DB level (because the external service owns its storage/constraints). This prevents mismatches between external service data and our database constraints.
- **Timing**
  - **Timing hacks**: Avoid setTimeout, nextTick, requestAnimationFrame, and similar timing workarounds when used to paper over race conditions or architectural issues. Fix the root cause instead of adding delays. Legitimate uses (e.g., debouncing, throttling) are fine.

## Repo Constraints
- **Database migrations**: Do NOT create new migration files. Only modify the initial migration in `supabase/migrations`. This is a new app with no users, so destructive schema changes are OK.
- **Generated files**: Do NOT modify `src/lib/db/generated/database.types.ts` directly. This file is auto-generated from the Supabase schema. If type issues arise, use type assertions in application code or regenerate the types using the Supabase CLI.

## Tech Stack
- **Testing**: See `tests/AGENTS.md` for test framework, mocking, and assertion rules.
- **Linting/Formatting**: Biome only (No Prettier or ESLint)
  - **Astro files excluded from Biome**: Astro files (`.astro`) are excluded from Biome's `files.includes` pattern in `biome.jsonc` because Biome's formatter repeatedly adds blank lines after frontmatter `---` delimiters when `html.experimentalFullSupportEnabled` is true. Formatter overrides don't prevent this behavior. Astro files are not linted or formatted by Biome as a result. The `package.json` lint-staged config includes `astro` for consistency, but Biome will ignore those files.
- **Styling**: Tailwind utilities preferred over custom CSS
- **Icons**:
  - **Astro files (`.astro`)**: Use `Icon` from `astro-icon/components` (e.g., `<Icon name="arrow-left" class="w-4 h-4" />`). Icons load from `src/icons/*.svg`.
  - **Vue files (`.vue`)**: Do **not** import `astro-icon/components` (Astro components can’t run in the browser). Instead, import SVGs from `src/icons/` as Vue components (via `vite-svg-loader`) (e.g., `import ChevronDownIcon from "../../../icons/chevron-down.svg?component"` then `<ChevronDownIcon class="h-5 w-5" />`). Vue imports must use `?component` to match the repo's vite-svg-loader configuration and existing components like PhoneInput.vue and PreviewPanel.vue.
  - Store all icon SVGs in `src/icons/`. Avoid inline `<svg>` markup in templates.
- **CI/CD**: GitHub Actions for continuous integration and deployment
- **Security**: Astro v5 enables CSRF protection by default via `security.checkOrigin: true` (see [Astro v5 upgrade guide](https://docs.astro.build/en/guides/upgrade-to/v5/#csrf-protection-is-now-set-by-default)). This protection applies to on-demand rendered pages for POST/PATCH/DELETE/PUT requests with form content types. The scope of protection for API routes (`src/pages/api/*.ts`) is not explicitly documented; verify behavior if implementing additional CSRF measures.
- **Supabase Auth – OTP / verification types**: `resend({ type: "signup" })` is correct when resending the signup confirmation email. The verification link in that email and `verifyOtp()` use `type: "email"` for sign-up; Supabase deprecates `signup` for verifyOtp. Whitelist only the verifyOtp types (`email`, `invite`, `magiclink`, `recovery`, `email_change`) in `verified.astro` and `SupabaseEmailOtpType`. Do not add `signup` as a verification type—review bots often suggest this incorrectly.

## Available CLI Tools
The following CLI tools are available: Biome CLI, Cursor CLI, CodeRabbit CLI, Vercel CLI, GitHub CLI, Supabase CLI.

## Design System
- **Semantic tokens live in `src/global.css`** via Tailwind v4 `@theme` variables (primary, success, warning, error, info).
- **Status UI is standardized**: use `StatusMessage.astro` / `StatusMessage.vue` or `status-tone-*` classes instead of custom color blocks.
- **Neutral palette**: prefer `gray-*` utilities for UI surfaces/text/borders.

## Section Comments
Use section comments to organize larger modules. For section headers, use the single-line format:
```txt
/* ============= Section Title ============= */
```

For longer multi-line comments, use:
```txt
/* =============
Comment Title
============= */
```