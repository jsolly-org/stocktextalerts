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
- **Local migration files are the source of truth.** Create migrations with `supabase migration new <name>`, write the SQL, commit, and merge to `main`. CI runs `supabase db push` to apply them to production.
- **Never apply migrations directly to production.** This includes: MCP `apply_migration` against the production database, running `supabase db push` locally, or executing DDL in the Supabase dashboard SQL editor. Any of these cause version drift that breaks CI.
- **MCP `apply_migration` is for local development only.** Use it to iterate on your local Supabase database. The production path is always: local file → git commit → merge to main → CI deploys.
- After creating or modifying a migration, run `npm run db:gen-types` to keep TypeScript types in sync.

### Generated Files
- Do NOT modify `src/lib/db/generated/database.types.ts`. Regenerate with `npm run db:gen-types` or use type assertions.

### Available CLIs (Machine-Specific Audit)
Last audited: 2026-02-28.

Installed and verified:
- `codex`, `claude`, `cursor`
- `git`, `gh`
- `rg`, `fd`, `fzf`, `bat`, `eza`, `jq`, `yq`
- `node`, `npm`, `pnpm`
- `supabase`
- `psql`, `sqlite3`
- `docker`
- `terraform`, `kubectl`
- `vercel`, `aws`
- `twilio` (profile: `solly`, manages phone numbers, API keys, and debugging)
- `python3`, `pipx`
- `delta`, `lazygit`, `direnv`, `zoxide`
- `make`, `tree`, `curl`
