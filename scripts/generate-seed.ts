import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient, User as AuthUser } from '@supabase/supabase-js';
type Stock = {
  symbol: string;
  name: string;
  exchange: string;
};
import { rootLogger } from '../src/lib/logging';
import {
  buildAuthIdentitySql,
  buildAuthUserSql,
  buildPublicUserSql,
  buildUserStocksSql,
  escapeSql,
  type SeedUser,
} from './seed-sql';

type SeedErrorCode =
  | "missing_env"
  | "invalid_supabase_url"
  | "non_local_supabase_url"
  | "default_password_missing"
  | "stocks_read_failed"
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
    "   - Verify PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set",
    "   - For local development, run: supabase start",
  ],
  default_password_missing: [
    "\n💡 Hint: DEFAULT_PASSWORD is required in .env.local",
    "   - Add DEFAULT_PASSWORD=your-password to .env.local",
  ],
  stocks_read_failed: [
    "\n💡 Hint: File read error.",
    "   - Check that us-stocks.json exists in scripts/",
    "   - Verify file permissions and JSON format",
  ],
  users_parse_failed: [
    "\n💡 Hint: File parse error.",
    "   - Check that users.json exists in scripts/",
    "   - Ensure the file is named users.json (not sample-users.json)",
    "   - Verify file permissions and JSON format",
  ],
  network_failed: [
    "\n💡 Hint: Supabase connection issue.",
    "   - Ensure Supabase is running: supabase start",
    "   - Verify PUBLIC_SUPABASE_URL points to a running instance",
    "   - Check network connectivity",
  ],
  auth_failed: [
    "\n💡 Hint: Authentication error.",
    "   - Verify SUPABASE_SERVICE_ROLE_KEY is correct",
    "   - Check that the service role key matches your Supabase instance",
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
const projectRoot = path.join(__dirname, '..');

const STOCKS_FILE = path.join(__dirname, 'us-stocks.json');
const USERS_FILE = path.join(__dirname, 'users.json');
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

function generateStocksSql(stocks: Stock[]): string {
  if (stocks.length === 0) return '';

  const values = stocks
    .map(
      (s) =>
        `('${escapeSql(s.symbol)}', '${escapeSql(s.name)}', '${escapeSql(s.exchange)}')`
    )
    .join(',\n  ');

  return `
INSERT INTO public.stocks (symbol, name, exchange)
VALUES
  ${values}
ON CONFLICT (symbol) DO NOTHING;
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

async function generateUsersSql(
  users: SeedUser[],
  supabase: SupabaseClient,
): Promise<string> {
  if (users.length === 0) return '';

  // Security note: the generated `supabase/seed.sql` is intended for local/dev only.
  // It includes SQL that hashes a password derived from `DEFAULT_PASSWORD` (from `.env.local`).
  // Keep `.env.local` and `supabase/seed.sql` out of version control and never use production passwords here.
  const defaultPassword = process.env.DEFAULT_PASSWORD;
  if (!defaultPassword) {
    throw new SeedError(
      "default_password_missing",
      "DEFAULT_PASSWORD environment variable is not defined in .env.local",
    );
  }

  const existingUsers = await listAllAuthUsers(supabase);
  const existingUserIdByEmail = new Map(
    existingUsers
      .map((u) => [u.email?.toLowerCase(), u.id] as const)
      .filter(([email]) => Boolean(email)),
  );

  let sql = '';

  for (const user of users) {
    const userEmailRaw = (user.email || '').trim();
    if (!userEmailRaw) {
      throw new Error(`Invalid seed user: email cannot be empty. User data: ${JSON.stringify(user)}`);
    }
    if (!isProbablyEmail(userEmailRaw)) {
      throw new Error(`Invalid seed user: email is not a valid format: "${userEmailRaw}". User data: ${JSON.stringify(user)}`);
    }

    const userEmailLookup = userEmailRaw.toLowerCase();
    const userPasswordRaw = defaultPassword;

    let trackedStocks: string[] = [];
    if (user.tracked_stocks !== undefined && user.tracked_stocks !== null) {
      if (!Array.isArray(user.tracked_stocks)) {
        throw new Error(
          `Invalid seed user: tracked_stocks must be an array, null, or undefined. Received: ${typeof user.tracked_stocks}. User data: ${JSON.stringify(user)}`,
        );
      }
      for (let i = 0; i < user.tracked_stocks.length; i++) {
        const stock = user.tracked_stocks[i];
        if (typeof stock !== "string") {
          throw new Error(
            `Invalid seed user: tracked_stocks[${i}] must be a string. Received: ${typeof stock}. User data: ${JSON.stringify(user)}`,
          );
        }
        const trimmed = stock.trim();
        if (!trimmed) {
          throw new Error(
            `Invalid seed user: tracked_stocks[${i}] cannot be empty or whitespace-only. User data: ${JSON.stringify(user)}`,
          );
        }
        if (/\s/.test(trimmed)) {
          throw new Error(
            `Invalid seed user: tracked_stocks[${i}] cannot contain whitespace. Received: "${trimmed}". User data: ${JSON.stringify(user)}`,
          );
        }
        trackedStocks.push(trimmed);
      }
    }

    // If user exists, use their ID. If not, generate a new UUID for the seed file.
    // We do NOT create the user here. The seed file will handle creation.
    const userId = existingUserIdByEmail.get(userEmailLookup) || randomUUID();

    sql += `-- User: ${escapeSql(userEmailRaw)} (ID: ${userId})\n`;

    sql += buildAuthUserSql(userId, userEmailRaw, userPasswordRaw);
    sql += buildAuthIdentitySql(userId, userEmailRaw);
    sql += buildPublicUserSql(userId, user);
    sql += buildUserStocksSql(userId, trackedStocks);
  }

  return sql;
}

async function main() {
  rootLogger.info('Generating supabase/seed.sql...');

  // Check for required environment variables
  const supabaseUrl = process.env.PUBLIC_SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const seedEnv = process.env.SEED_ENV;

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new SeedError(
      "missing_env",
      "Missing required environment variables: PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local",
    );
  }

  let supabaseHost: string;
  try {
    supabaseHost = new URL(supabaseUrl).hostname;
  } catch {
    throw new SeedError(
      "invalid_supabase_url",
      `PUBLIC_SUPABASE_URL is not a valid URL: ${supabaseUrl}`,
    );
  }

  const isLocalSupabase =
    supabaseHost === 'localhost' || supabaseHost === '127.0.0.1';

  if (!isLocalSupabase && seedEnv !== 'local') {
    throw new SeedError(
      "non_local_supabase_url",
      `Refusing to use SUPABASE_SERVICE_ROLE_KEY against non-local Supabase URL (${supabaseUrl}). Set SEED_ENV=local to override.`,
    );
  }

  // Create Supabase admin client
  const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  // 1. Read Stocks Data
  let stocksData;
  try {
    stocksData = JSON.parse(fs.readFileSync(STOCKS_FILE, 'utf-8'));
  } catch (error) {
    throw new SeedError(
      "stocks_read_failed",
      `Failed to read ${STOCKS_FILE}: ${error instanceof Error ? error.message : error}`,
      { cause: error },
    );
  }

  const stocks = stocksData.data || [];

  // 2. Read Users Data
  let users: SeedUser[] = [];
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

  // 3. Generate SQL
  const stocksSql = generateStocksSql(stocks);
  const usersSql = await generateUsersSql(users, supabase);

  const sections = [
    `-- 1. Stocks\n${stocksSql.trimEnd()}`.trimEnd(),
    `-- 2. Users (auth + public profile + tracked stocks)\n${usersSql.trimEnd()}`.trimEnd(),
  ];

  const fullSql = `/*
  Auto-generated seed file. 
  Generated by scripts/generate-seed.ts
  Do not edit manually.
  
  Local/dev only: includes auth user creation and password hashing derived from DEFAULT_PASSWORD.
*/

${sections.join('\n\n')}
`;

  // 4. Write File
  fs.writeFileSync(SEED_FILE, fullSql);

  rootLogger.info(
    [
      `✅ seed.sql generated at ${SEED_FILE}`,
      `   - ${stocks.length} stocks`,
      `   - ${users.length} users`,
    ].join("\n"),
  );
}

main().catch((error) => {
  rootLogger.error("\n❌ Error generating seed file:", undefined, error);

  if (error instanceof SeedError) {
    const hints = ERROR_HINTS[error.code];
    if (hints) {
      rootLogger.info(hints.join("\n"));
    }
  }

  process.exitCode = 1;
});
