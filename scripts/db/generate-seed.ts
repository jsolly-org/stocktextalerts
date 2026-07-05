import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient, User as AuthUser } from '@supabase/supabase-js';
type Asset = {
  symbol: string;
  name: string;
  type: string;
  icon_url: string | null;
};
import { rootLogger } from '../../src/lib/logging';
import {
  buildAuthIdentitySql,
  buildAuthUserSql,
  buildPublicUserSql,
  buildUserAssetsSql,
  escapeSql,
  type SeedUser,
} from './seed-sql';
import { isLocalHost } from './is-local-host';

type SeedErrorCode =
  | "missing_env"
  | "invalid_supabase_url"
  | "default_password_missing"
  | "assets_read_failed"
  | "users_parse_failed"
  | "network_failed"
  | "auth_failed"
  | "list_users_failed";

class SeedError extends Error {
  code: SeedErrorCode;

  constructor(code: SeedErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.name = "SeedError";
  }
}

const ERROR_HINTS: Partial<Record<SeedErrorCode, string[]>> = {
  missing_env: [
    "\n💡 Hint: Missing environment variables.",
    "   - Ensure .env.local exists in the project root",
    "   - Verify SUPABASE_URL and SUPABASE_SECRET_KEY are set",
    "   - For local development, run: supabase start",
  ],
  invalid_supabase_url: [
    "\n💡 Hint: SUPABASE_URL is malformed.",
    "   - Verify the URL format (e.g., http://localhost:54321)",
  ],
  default_password_missing: [
    "\n💡 Hint: DEFAULT_PASSWORD is required in .env.local",
    "   - Add DEFAULT_PASSWORD=your-password to .env.local",
  ],
  assets_read_failed: [
    "\n💡 Hint: File read error.",
    "   - Check that us-assets.json exists in scripts/data/",
    "   - Verify file permissions and JSON format",
  ],
  users_parse_failed: [
    "\n💡 Hint: File parse error.",
    "   - Check that users.json exists in scripts/data/",
    "   - Ensure the file is named users.json (not sample-users.json)",
    "   - Verify file permissions and JSON format",
  ],
  network_failed: [
    "\n💡 Hint: Supabase connection issue.",
    "   - Ensure Supabase is running: supabase start",
    "   - Verify SUPABASE_URL points to a running instance",
    "   - Check network connectivity",
  ],
  auth_failed: [
    "\n💡 Hint: Authentication error.",
    "   - Verify SUPABASE_SECRET_KEY is correct",
    "   - Check that the secret key matches your Supabase instance",
  ],
  list_users_failed: [
    "\n💡 Hint: Error fetching users from Supabase.",
    "   - Check Supabase connection and service role key",
    "   - Verify auth schema is properly set up",
  ],
};

const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
]);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..', '..');

const ASSETS_FILE = path.join(projectRoot, 'scripts', 'data', 'us-assets.json');
const USERS_FILE = path.join(projectRoot, 'scripts', 'data', 'users.json');
const SEED_FILE = path.join(projectRoot, 'supabase', 'seed.sql');

function isProbablyEmail(email: string): boolean {
  if (!email) return false;
  if (/\s/.test(email)) return false;

  const parts = email.split('@');
  if (parts.length !== 2) return false;

  const [local, domain] = parts;
  return Boolean(local && domain);
}

function getErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  if ("code" in error && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }

  if ("cause" in error) {
    return getErrorCode((error as { cause?: unknown }).cause);
  }

  return null;
}

function getErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  if ("status" in error && typeof (error as { status?: unknown }).status === "number") {
    return (error as { status: number }).status;
  }

  return null;
}

function isNetworkError(error: unknown): boolean {
  const code = getErrorCode(error);
  return code ? NETWORK_ERROR_CODES.has(code) : false;
}

function generateAssetsSql(assets: Asset[]): string {
  if (assets.length === 0) return '';

  const values = assets
    .map(
      (s) => {
        const iconUrl = s.icon_url ? `'${escapeSql(s.icon_url)}'` : 'NULL';
        return `('${escapeSql(s.symbol)}', '${escapeSql(s.name)}', '${escapeSql(s.type)}', ${iconUrl})`;
      }
    )
    .join(',\n  ');

  return `
INSERT INTO public.assets (symbol, name, type, icon_url)
VALUES
  ${values}
ON CONFLICT (symbol) DO UPDATE SET
  name = EXCLUDED.name,
  type = EXCLUDED.type,
  icon_url = COALESCE(EXCLUDED.icon_url, assets.icon_url);
`;
}

async function listAllAuthUsers(supabase: SupabaseClient): Promise<AuthUser[]> {
  const perPage = 1000;
  const maxPages = 100;
  let page = 1;
  const users: AuthUser[] = [];

  while (true) {
    try {
      const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
      if (error) {
        throw error;
      }

      const batch = data.users ?? [];
      users.push(...batch);

      if (batch.length < perPage) break;

      page += 1;
      if (page > maxPages) {
        throw new SeedError(
          "list_users_failed",
          `listAllAuthUsers: Maximum page limit (${maxPages}) reached. This may indicate API misbehavior or unexpectedly large user count. Accumulated ${users.length} users before limit was hit.`,
        );
      }
    } catch (error) {
      const status = getErrorStatus(error);
      if (status === 401 || status === 403) {
        throw new SeedError(
          "auth_failed",
          "Failed to list auth users due to authorization error.",
          { cause: error },
        );
      }

      if (isNetworkError(error)) {
        throw new SeedError(
          "network_failed",
          "Failed to list auth users due to a network error.",
          { cause: error },
        );
      }

      if (error instanceof SeedError) {
        throw error;
      }

      throw new SeedError(
        "list_users_failed",
        "Failed to list auth users.",
        { cause: error },
      );
    }
  }

  return users;
}

type NormalizedSeedUser = {
  userId: string;
  emailRaw: string;
  password: string;
  user: SeedUser;
  trackedAssets: string[];
};

async function normalizeSeedUsers(
  users: SeedUser[],
  supabase: SupabaseClient,
): Promise<NormalizedSeedUser[]> {
  // Security note: this script can be run against any Supabase project (including production).
  // If `scripts/data/users.json` is present, the generated `supabase/seed.sql` will create auth users
  // with a password derived from `DEFAULT_PASSWORD` (from `.env.local`).
  // Treat both `.env.local` and `supabase/seed.sql` as sensitive and never reuse real production passwords here.
  const defaultPassword = process.env.DEFAULT_PASSWORD;
  if (!defaultPassword) {
    throw new SeedError(
      "default_password_missing",
      "DEFAULT_PASSWORD environment variable is not defined in .env.local",
    );
  }

  let existingUsers: AuthUser[];
  try {
    existingUsers = await listAllAuthUsers(supabase);
  } catch (err) {
    // Supabase may be down or auth not ready (e.g. before first db reset).
    // We proceed with no existing users so we assign fresh UUIDs; the seed
    // file is still valid and `supabase db reset` will apply it.
    //
    // This used to be a silent `info` log, but that was a known source of
    // seed↔DB desync: if a dev regenerated seed.sql while Supabase was
    // transiently down, they'd later apply a seed whose user IDs don't
    // match a previously-live DB row. Warn loudly so it's obvious in
    // terminal output.
    rootLogger.warn(
      "Could not list existing auth users; proceeding with fresh UUIDs. " +
        "If Supabase should be running, re-run `npm run db:start` and then " +
        "`npm run db:generate-seed` to keep seed.sql aligned with live IDs.",
      { context: { cause: err instanceof Error ? err.message : String(err) } },
    );
    existingUsers = [];
  }
  const existingUserIdByEmail = new Map(
    existingUsers
      .map((u) => [u.email?.toLowerCase(), u.id] as const)
      .filter(([email]) => Boolean(email)),
  );

  const normalized: NormalizedSeedUser[] = [];

  for (const user of users) {
    // Normalize seed input since JSON files aren't constrained and auth.users is external.
    const userEmailRaw = (user.email || '').trim();
    if (!userEmailRaw) {
      throw new SeedError(
        "users_parse_failed",
        `Invalid seed user: email cannot be empty. User data: ${JSON.stringify(user)}`,
      );
    }
    if (!isProbablyEmail(userEmailRaw)) {
      throw new SeedError(
        "users_parse_failed",
        `Invalid seed user: email is not a valid format: "${userEmailRaw}". User data: ${JSON.stringify(user)}`,
      );
    }

    const userEmailLookup = userEmailRaw.toLowerCase();

    let trackedAssets: string[] = [];
    if (user.tracked_assets !== undefined && user.tracked_assets !== null) {
      if (!Array.isArray(user.tracked_assets)) {
        throw new SeedError(
          "users_parse_failed",
          `Invalid seed user: tracked_assets must be an array, null, or undefined. Received: ${typeof user.tracked_assets}. User data: ${JSON.stringify(user)}`,
        );
      }
      for (let i = 0; i < user.tracked_assets.length; i++) {
        const asset = user.tracked_assets[i];
        if (typeof asset !== "string") {
          throw new SeedError(
            "users_parse_failed",
            `Invalid seed user: tracked_assets[${i}] must be a string. Received: ${typeof asset}. User data: ${JSON.stringify(user)}`,
          );
        }
        // Normalize seed input; whitespace is common in CSV/JSON exports.
        const trimmed = asset.trim();
        if (!trimmed) {
          throw new SeedError(
            "users_parse_failed",
            `Invalid seed user: tracked_assets[${i}] cannot be empty or whitespace-only. User data: ${JSON.stringify(user)}`,
          );
        }
        if (/\s/.test(trimmed)) {
          throw new SeedError(
            "users_parse_failed",
            `Invalid seed user: tracked_assets[${i}] cannot contain whitespace. Received: "${trimmed}". User data: ${JSON.stringify(user)}`,
          );
        }
        trackedAssets.push(trimmed);
      }
    }

    // If user exists, use their ID. If not, generate a new UUID for the seed file.
    // We do NOT create the user here. The seed file will handle creation.
    const userId = existingUserIdByEmail.get(userEmailLookup) || randomUUID();

    normalized.push({
      userId,
      emailRaw: userEmailRaw,
      password: defaultPassword,
      user,
      trackedAssets,
    });
  }

  return normalized;
}

/**
 * Per-user auth + public profile SQL, wrapped in BEGIN/COMMIT so a failure on
 * one user aborts that user's block (under `\set ON_ERROR_STOP on`) without
 * leaving `auth.users` populated and `public.users` empty.
 *
 * Assets/user_assets are emitted separately — this block must run BEFORE
 * `public.assets` is seeded so a partial failure (e.g. empty assets) is not
 * silently recoverable into a "logged-in user with no tracked assets" state.
 */
function generateUsersAuthSql(normalized: NormalizedSeedUser[]): string {
  let sql = '';
  for (const { userId, emailRaw, password, user } of normalized) {
    sql += `-- User: ${escapeSql(emailRaw)} (ID: ${userId})\n`;
    sql += `BEGIN;\n`;
    sql += buildAuthUserSql(userId, emailRaw, password);
    sql += buildAuthIdentitySql(userId, emailRaw);
    sql += buildPublicUserSql(userId, user);
    sql += `COMMIT;\n`;
  }
  return sql;
}

/** Per-user `user_assets` inserts, emitted AFTER `public.assets` is seeded. */
function generateUserAssetsSql(normalized: NormalizedSeedUser[]): string {
  const blocks = normalized
    .filter(({ trackedAssets }) => trackedAssets.length > 0)
    .map(({ userId, emailRaw, trackedAssets }) => {
      const header = `-- User assets: ${escapeSql(emailRaw)} (ID: ${userId})\n`;
      return `${header}BEGIN;${buildUserAssetsSql(userId, trackedAssets)}COMMIT;\n`;
    });
  return blocks.join('');
}

/**
 * Post-seed integrity check. Fails loudly if any expected user or any user's
 * tracked assets didn't land — this is the guardrail against the silent
 * partial-seed class of bugs where `supabase start` skips part of the seed.
 *
 * `seededSymbols` is the intersection with `public.assets` rows we're about
 * to insert. We only verify symbols that are actually expected to land, so a
 * `users.json` entry referencing a delisted or non-US ticker (absent from
 * `us-assets.json`) doesn't cause the verification to false-positive.
 */
function generateSeedVerificationSql(
  normalized: NormalizedSeedUser[],
  seededSymbols: Set<string>,
): string {
  if (normalized.length === 0) return '';

  const userChecks = normalized
    .map(({ userId, emailRaw }) => {
      const emailLit = `'${escapeSql(emailRaw)}'`;
      const idLit = `'${userId}'::uuid`;
      return `  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = ${idLit}) THEN
    RAISE EXCEPTION 'Seed verification failed: auth.users row for % (id %) was not created', ${emailLit}, ${idLit};
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = ${idLit}) THEN
    RAISE EXCEPTION 'Seed verification failed: public.users row for % (id %) was not created', ${emailLit}, ${idLit};
  END IF;`;
    })
    .join('\n');

  const assetChecks = normalized
    .map(({ userId, emailRaw, trackedAssets }) => {
      const expectedSymbols = trackedAssets.filter((s) => seededSymbols.has(s));
      if (expectedSymbols.length === 0) return '';
      const emailLit = `'${escapeSql(emailRaw)}'`;
      const idLit = `'${userId}'::uuid`;
      const symbolsLit = expectedSymbols
        .map((s) => `'${escapeSql(s)}'`)
        .join(', ');
      return `  IF NOT EXISTS (
    SELECT 1 FROM public.user_assets
    WHERE user_id = ${idLit}
      AND symbol IN (${symbolsLit})
  ) THEN
    RAISE EXCEPTION 'Seed verification failed: no tracked assets landed for % (id %); expected any of (${symbolsLit.replace(/'/g, "''")})', ${emailLit}, ${idLit};
  END IF;`;
    })
    .filter(Boolean)
    .join('\n');

  return `
DO $$
BEGIN
${userChecks}
${assetChecks}
END $$;
`;
}

async function main() {
  rootLogger.info('Generating supabase/seed.sql...');

  // Check for required environment variables
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;
  // Seed scripts run outside middleware, so env validation lives here.
  if (!supabaseUrl || !supabaseSecretKey) {
    throw new SeedError(
      "missing_env",
      "Missing required environment variables: SUPABASE_URL and SUPABASE_SECRET_KEY must be set in .env.local",
    );
  }

  let supabaseHost: string;
  try {
    supabaseHost = new URL(supabaseUrl).hostname;
  } catch {
    throw new SeedError(
      "invalid_supabase_url",
      `SUPABASE_URL is not a valid URL: ${supabaseUrl}`,
    );
  }

  const isLocalSupabase = isLocalHost(supabaseHost);

  // Create Supabase admin client
  const supabase = createClient(supabaseUrl, supabaseSecretKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  // 1. Read Assets Data
  let assetsData;
  try {
    assetsData = JSON.parse(fs.readFileSync(ASSETS_FILE, 'utf-8'));
  } catch (error) {
    throw new SeedError(
      "assets_read_failed",
      `Failed to read ${ASSETS_FILE}: ${error instanceof Error ? error.message : error}`,
      { cause: error },
    );
  }

  if (assetsData === null || typeof assetsData !== "object" || Array.isArray(assetsData)) {
    throw new SeedError(
      "assets_read_failed",
      `${ASSETS_FILE} must contain a JSON object with a 'data' property; received ${assetsData === null ? "null" : Array.isArray(assetsData) ? "array" : typeof assetsData}`,
    );
  }

  const assetsRaw = assetsData.data;
  if (!Array.isArray(assetsRaw)) {
    throw new SeedError(
      "assets_read_failed",
      `${ASSETS_FILE}: 'data' property must be an array; received ${typeof assetsRaw}`,
    );
  }

  for (let i = 0; i < assetsRaw.length; i++) {
    const asset = assetsRaw[i];
    if (asset === null || typeof asset !== "object" || Array.isArray(asset)) {
      throw new SeedError(
        "assets_read_failed",
        `${ASSETS_FILE}: assets[${i}] must be an object. Received: ${asset === null ? "null" : Array.isArray(asset) ? "array" : typeof asset}`,
      );
    }
    if (typeof asset.symbol !== "string" || typeof asset.name !== "string" || typeof asset.type !== "string") {
      throw new SeedError(
        "assets_read_failed",
        `${ASSETS_FILE}: assets[${i}] must have string properties 'symbol', 'name', and 'type'. Received: ${JSON.stringify(asset)}`,
      );
    }
    if (!("icon_url" in asset) || (asset.icon_url !== null && typeof asset.icon_url !== "string")) {
      throw new SeedError(
        "assets_read_failed",
        `${ASSETS_FILE}: assets[${i}].icon_url must be present and be a string or null. Received: ${typeof asset.icon_url}`,
      );
    }
  }

  const assets = assetsRaw as Asset[];

  // 2. Read Users Data
  let users: SeedUser[] = [];
  // `supabase/seed.sql` includes auth user creation derived from DEFAULT_PASSWORD.
  // If `users.json` exists, always include it so resets (including prod) restore users.
  if (fs.existsSync(USERS_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8')) as unknown;
      if (!Array.isArray(parsed)) {
        throw new Error(
          `${USERS_FILE} must contain a JSON array of users (SeedUser[]) for generateUsersSql; received ${typeof parsed}`,
        );
      }
      for (let i = 0; i < parsed.length; i++) {
        const user = parsed[i];
        if (user === null || typeof user !== "object" || Array.isArray(user)) {
          throw new Error(
            `${USERS_FILE}: users[${i}] must be an object. Received: ${user === null ? "null" : Array.isArray(user) ? "array" : typeof user}`,
          );
        }
      }
      users = parsed as SeedUser[];
    } catch (error) {
      throw new SeedError(
        "users_parse_failed",
        `Failed to parse ${USERS_FILE}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  if (users.length > 0 && !isLocalSupabase) {
    rootLogger.warn(
      "Seeding auth users from scripts/data/users.json into a non-local Supabase project. These users will be created with a password derived from DEFAULT_PASSWORD.",
      { supabaseHost, usersFile: USERS_FILE, usersCount: users.length },
    );
  }

  // 3. Generate SQL
  const normalizedUsers = await normalizeSeedUsers(users, supabase);
  const assetsSql = generateAssetsSql(assets);
  const usersAuthSql = generateUsersAuthSql(normalizedUsers);
  const userAssetsSql = generateUserAssetsSql(normalizedUsers);
  const seededSymbols = new Set(assets.map((a) => a.symbol));
  const verificationSql = generateSeedVerificationSql(
    normalizedUsers,
    seededSymbols,
  );

  // Order matters: users come BEFORE assets so a partial-seed failure surfaces
  // as "login broken" (loud + obvious) rather than "user silently missing while
  // assets succeed" (the regression that motivated this hardening).
  // user_assets runs last because its rows reference both auth.users and public.assets.
  const sections = [
    `-- 1. Users (auth + public profile)\n${usersAuthSql.trimEnd()}`.trimEnd(),
    `-- 2. Assets\n${assetsSql.trimEnd()}`.trimEnd(),
    `-- 3. User tracked assets\n${userAssetsSql.trimEnd()}`.trimEnd(),
    verificationSql.trim()
      ? `-- 4. Seed integrity verification (fails loudly if any expected row is missing)\n${verificationSql.trimEnd()}`.trimEnd()
      : '',
  ].filter(Boolean);

  const fullSql = `/*
  Auto-generated seed file.
  Generated by scripts/db/generate-seed.ts
  Do not edit manually.

  Partial-seed safety:
    - Per-user blocks are wrapped in BEGIN/COMMIT for per-user atomicity.
    - Section 4 raises an exception if any expected row is missing, so any
      silent partial seed fails the overall db:reset instead of leaving a
      half-bootstrapped stack.

  If scripts/data/users.json exists, this seed includes auth user creation with passwords derived from DEFAULT_PASSWORD.
  Be careful applying this seed to production.
*/

-- The squashed migration ends with \`set_config('search_path', '', false)\`
-- (pg_dump default). Restore a sane search_path that includes \`extensions\`
-- so calls like crypt()/gen_salt() resolve without per-callsite qualification.
SET search_path = public, extensions, pg_catalog;

${sections.join('\n\n')}
`;

  // 4. Write File
  fs.writeFileSync(SEED_FILE, fullSql);

  rootLogger.info(
    [
      `✅ seed.sql generated at ${SEED_FILE}`,
      `   - ${assets.length} assets`,
      `   - ${users.length} users`,
    ].join("\n"),
  );
}

main().catch((error) => {
  rootLogger.error(
    "\n❌ Error generating seed file:",
    { action: "generate_seed_file", seedFile: SEED_FILE },
    error,
  );

  if (error instanceof SeedError) {
    const hints = ERROR_HINTS[error.code];
    if (hints) {
      rootLogger.info(hints.join("\n"));
    }
  }

  process.exitCode = 1;
});
