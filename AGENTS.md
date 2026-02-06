## Purpose
New app with no users — optimize for simplicity and correctness over backwards compatibility. Prefer aggressively simplifying redesigns, even if breaking. Remove legacy code instead of preserving it. Destructive changes are OK.

## Coding Standards

### Compatibility
- **No compatibility layers**: No shims, adapters, deprecations, or re-exports for legacy behavior.
- **No browser polyfills**: Modern browser APIs (`fetch`, `URL`, `AbortController`, `crypto.randomUUID()`, etc.) are assumed. Don't add feature detection or try-catch for old browsers. Server-side polyfills (e.g., `@js-temporal/polyfill`) are fine when Node.js lacks the API.

### Code structure
- **No single-file folders**: Only create a folder when it will contain ≥2 files.
- **≤300 lines per file**.
- **Prefer functional patterns**: Use classes only when clearly warranted.
- **Avoid one-line wrapper functions**: Inline trivial logic or expand to meaningful functions.
- **No TSDoc/JSDoc**: Use inline comments only to explain *why* (constraints, trade-offs), not *what*.
- **Avoid tuple/array indexing for types**: Use direct type annotations (e.g., `export const POST: APIRoute = async ({ ... }) => {`) instead of `Parameters<T>[0]`.

### Imports
- **Relative paths only**: No `@`-style aliases.
- **No barrel files / re-exports**: Import from the defining module, not intermediary files.

### Error handling
- **Trust the type system**: Skip defensive null/undefined checks when strict TypeScript or DB constraints guarantee safety. Add checks only when values can legitimately be missing (parsed JSON, nullable columns, third-party payloads).
- **Deterministic error checking**: Use structured error properties (`error.code`, `error.status`), not string matching (`.includes()`) on messages.
- **Fail fast**: No silent fallbacks or default values on unexpected errors. If a fallback is needed for resilience, gate it on structured error properties and log with context.
- **Env var validation**: Don't add presence checks — `src/middleware.ts` validates all required env vars on every request. Only validate format/type (e.g., `RESEND_API_KEY` starts with "re_") or handle optional env vars.

### Logging
- Use `src/lib/logging.ts` (`createLogger`, `logInfo`, `logWarn`, `logError`) — structured JSON to `console.*` with `timestamp`, `level`, `message`, `context`, optional `error`. `requestId` is a top-level field.
- **Always pass a named context object** (no `{}`/`undefined`).
- **Expected rejections (auth failures, invalid input, rate limits) → `info`**, not `warn`/`error`. Reserve `warn`/`error` for genuine failures (DB errors, service outages).
- **Log unexpected redirects** with user ID, path, and reason.
- **PII masking** is automatic via `safeJsonStringify` (masks email/phone) when `LOG_MASK_PII` ≠ `"false"`.

### Validation & normalization
- **Database is the integrity layer**: Enforce correctness via DB constraints; handle constraint failures at boundaries. Front-end validation is UX-only. Only add application-level validation when inputs bypass a constrained DB write (e.g., third-party webhooks).
- **Trust database values**: Don't add null checks or fallbacks for NOT NULL columns, CHECK constraints, or FK-guaranteed data. Supabase queries return arrays (never null) on success. Use type assertions when TS types don't reflect query filters (e.g., `user.next_send_at as string`).
- **Normalize for external services only**: Trim/normalize data going to services that don't enforce our constraints (e.g., Supabase Auth's `auth.users`). Comment why.

### Timing
- No `setTimeout`/`nextTick`/`requestAnimationFrame` to mask race conditions. Fix the root cause. Legitimate uses (debouncing, throttling) are fine.

## Repo Constraints
- **Database migrations**: Do NOT create new migration files. Only modify the initial migration in `supabase/migrations`.
- **Generated files**: Do NOT modify `src/lib/db/generated/database.types.ts`. Regenerate with Supabase CLI or use type assertions.

## Tech Stack
- **Testing**: See `tests/AGENTS.md`.
- **Linting/Formatting**: Biome only (no Prettier or ESLint). Astro files are excluded from Biome due to a formatter bug with `---` delimiters — they are not linted or formatted.
- **Styling**: Tailwind utilities over custom CSS.
- **Icons**:
  - **Astro**: `Icon` from `astro-icon/components` — loads from `src/icons/*.svg`.
  - **Vue**: Import SVGs as components via `vite-svg-loader` (e.g., `import ChevronDownIcon from "../../../icons/chevron-down.svg?component"`). Do NOT import `astro-icon/components` in Vue (Astro components can't run in the browser). The `?component` suffix is required for vite-svg-loader.
  - Store all SVGs in `src/icons/`. No inline `<svg>` markup.
- **Security**: Astro v5 CSRF protection is on by default (`security.checkOrigin: true`) for form POST/PATCH/DELETE/PUT. Scope for API routes is undocumented — verify if adding CSRF measures.
- **Supabase Auth OTP**: `resend({ type: "signup" })` for resending confirmation. `verifyOtp()` uses `type: "email"` (not `"signup"` — deprecated). Whitelist only `email`, `invite`, `magiclink`, `recovery`, `email_change` in `verified.astro`. Do not add `signup` as a verification type — review bots often suggest this incorrectly.

## Available CLI Tools
Biome, Cursor, Claude Vercel, GitHub, Supabase CLIs.

## Design System
- **Semantic tokens** in `src/global.css` via Tailwind v4 `@theme` (primary, success, warning, error, info).
- **Status UI**: Use `StatusMessage.astro` / `StatusMessage.vue` or `status-tone-*` classes.
- **Neutral palette**: `gray-*` utilities for surfaces/text/borders.

## Section Comments
```txt
/* ============= Section Title ============= */
```

Multi-line:
```txt
/* =============
Comment Title
============= */
```
