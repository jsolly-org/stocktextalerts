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

### External Services & Access

#### AWS (profile: `prod-admin`, region: `us-east-1`)
- **SES**: Email delivery via `@aws-sdk/client-sesv2`. Domain `stocktextalerts.com` verified with DKIM. Dedicated IAM user `stocktextalerts-ses` with `SESsendOnly` policy.
- **SMS/Pinpoint**: AWS End User Messaging for SMS delivery and Pinpoint for OTP verification.
- Env vars: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `AWS_SMS_ORIGINATION_IDENTITY`, `AWS_PINPOINT_APP_ID`.

#### Cloudflare (DNS for `stocktextalerts.com`)
- Nameservers: `amanda.ns.cloudflare.com`, `vin.ns.cloudflare.com`.
- Zone ID: `964861175cbbb7133fc09c7e3f1e362f`.
- CLI: `wrangler` (installed globally via npm). Authenticate with `wrangler login`.
- DNS API requires an API token with "Edit zone DNS" permission scoped to `stocktextalerts.com`. The wrangler OAuth token only has `zone:read` — use a separate API token for DNS writes.

#### Vercel
- Deployment platform. Env vars managed via `vercel env add/rm`.
- `EMAIL_FROM` must match the sending domain verified in the active email provider.

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
- `vercel`, `aws`, `wrangler`
- `python3`, `pipx`
- `delta`, `lazygit`, `direnv`, `zoxide`
- `make`, `tree`, `curl`
