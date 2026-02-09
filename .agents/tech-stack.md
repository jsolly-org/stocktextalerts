## Tech Stack & Tools

### Linting/Formatting
- **Biome only** (no Prettier or ESLint). Astro files are excluded from Biome due to a formatter bug with `---` delimiters — they are not linted or formatted.

### Icons
- **Astro**: `Icon` from `astro-icon/components` — loads from `src/icons/*.svg`.
- **Vue**: Import SVGs as components via `vite-svg-loader` (e.g., `import ChevronDownIcon from "../../../icons/chevron-down.svg?component"`). The relative depth depends on the importing file location, but the `?component` suffix is required. Do NOT import `astro-icon/components` in Vue (Astro components can't run in the browser).
- Store all SVGs in `src/icons/`. No inline `<svg>` markup.

### Security
- Astro v5 CSRF protection is on by default (`security.checkOrigin: true`) for form POST/PATCH/DELETE/PUT. Scope for API routes is undocumented — verify if adding CSRF measures.

### Supabase Auth OTP
- `resend({ type: "signup" })` for resending confirmation.
- `verifyOtp()` uses `type: "email"` (not `"signup"` — deprecated).
- Whitelist only `email`, `invite`, `magiclink`, `recovery`, `email_change` in `verified.astro`. Do not add `signup` as a verification type.

### Supabase Migrations
- **Local files are the source of truth.** Always create the migration SQL file in `supabase/migrations/` first, then apply it to production using the Supabase MCP `apply_migration` tool with the **same version and name** as the local file.
- **Never apply migrations directly to production** without a corresponding local file. This causes version drift that is painful to reconcile.
- After applying a migration, run `npm run db:gen-types` to keep TypeScript types in sync.

### Generated Files
- Do NOT modify `src/lib/db/generated/database.types.ts`. Regenerate with `npm run db:gen-types` or use type assertions.

### Available CLIs
Biome, Cursor, Claude, Vercel, GitHub (`gh`), Supabase.
