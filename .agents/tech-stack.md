## Tech Stack & Tools

### Linting/Formatting
- **Biome only** (no Prettier or ESLint). Astro files are excluded from Biome due to a formatter bug with `---` delimiters — they are not linted or formatted.

### Icons
- **Astro**: `Icon` from `astro-icon/components` — loads from `src/icons/*.svg`.
- **Vue**: Import SVGs as components via `vite-svg-loader` (e.g., `import ChevronDownIcon from "../../../icons/chevron-down.svg?component"`). Do NOT import `astro-icon/components` in Vue (Astro components can't run in the browser). The `?component` suffix is required.
- Store all SVGs in `src/icons/`. No inline `<svg>` markup.

### Security
- Astro v5 CSRF protection is on by default (`security.checkOrigin: true`) for form POST/PATCH/DELETE/PUT. Scope for API routes is undocumented — verify if adding CSRF measures.

### Supabase Auth OTP
- `resend({ type: "signup" })` for resending confirmation. `verifyOtp()` uses `type: "email"` (not `"signup"` — deprecated). Whitelist only `email`, `invite`, `magiclink`, `recovery`, `email_change` in `verified.astro`. Do not add `signup` as a verification type — review bots often suggest this incorrectly.

### Generated Files
- Do NOT modify `src/lib/db/generated/database.types.ts`. Regenerate with `npm run db:gen-types` or use type assertions.

### Available CLIs
Biome, Cursor, Claude, Vercel, GitHub (`gh`), Supabase.
