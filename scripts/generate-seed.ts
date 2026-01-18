import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient, User as AuthUser } from '@supabase/supabase-js';
import type { Stock } from '../src/lib/stocks';
import {
  buildAuthIdentitySql,
  buildAuthUserSql,
  buildPublicUserSql,
  buildUserStocksSql,
  escapeSql,
  type SeedUser,
} from './seed-sql';

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
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw error;

    const batch = data.users ?? [];
    users.push(...batch);

    if (batch.length < perPage) break;

    page += 1;
    if (page > maxPages) {
      throw new Error(`listAllAuthUsers: Maximum page limit (${maxPages}) reached. This may indicate API misbehavior or unexpectedly large user count. Accumulated ${users.length} users before limit was hit.`);
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
    throw new Error('DEFAULT_PASSWORD environment variable is not defined in .env.local');
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

    const trackedStocks = Array.isArray(user.tracked_stocks)
      ? user.tracked_stocks
          .map((stock) => (typeof stock === 'string' ? stock.trim() : ''))
          .filter((stock) => stock.length > 0)
      : [];

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
  console.log('Generating supabase/seed.sql...');

  // Check for required environment variables
  const supabaseUrl = process.env.PUBLIC_SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const seedEnv = process.env.SEED_ENV;

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error(
      'Missing required environment variables: PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local',
    );
  }

  let supabaseHost: string;
  try {
    supabaseHost = new URL(supabaseUrl).hostname;
  } catch {
    throw new Error(`PUBLIC_SUPABASE_URL is not a valid URL: ${supabaseUrl}`);
  }

  const isLocalSupabase =
    supabaseHost === 'localhost' || supabaseHost === '127.0.0.1';

  if (!isLocalSupabase && seedEnv !== 'local') {
    throw new Error(
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
    throw new Error(`Failed to read ${STOCKS_FILE}: ${error instanceof Error ? error.message : error}`);
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
      users = parsed as SeedUser[];
    } catch (error) {
      throw new Error(
        `Failed to parse ${USERS_FILE}: ${error instanceof Error ? error.message : String(error)}`,
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

  console.log(`✅ seed.sql generated at ${SEED_FILE}`);
  console.log(`   - ${stocks.length} stocks`);
  console.log(`   - ${users.length} users`);
}

main().catch((error) => {
  console.error('\n❌ Error generating seed file:');
  console.error(error);

  const errorMessage = error instanceof Error ? error.message : String(error);

  // Check for common issues and provide hints
  if (errorMessage.includes('PUBLIC_SUPABASE_URL') || errorMessage.includes('SUPABASE_SERVICE_ROLE_KEY')) {
    console.error('\n💡 Hint: Missing environment variables.');
    console.error('   - Ensure .env.local exists in the project root');
    console.error('   - Verify PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set');
    console.error('   - For local development, run: supabase start');
  } else if (errorMessage.includes('DEFAULT_PASSWORD')) {
    console.error('\n💡 Hint: DEFAULT_PASSWORD is required in .env.local');
    console.error('   - Add DEFAULT_PASSWORD=your-password to .env.local');
  } else if (errorMessage.includes('Failed to read') || errorMessage.includes('Failed to parse')) {
    console.error('\n💡 Hint: File read error.');
    console.error('   - Check that us-stocks.json exists in scripts/');
    console.error('   - Verify file permissions and JSON format');
  } else if (errorMessage.includes('fetch') || errorMessage.includes('ECONNREFUSED') || errorMessage.includes('network')) {
    console.error('\n💡 Hint: Supabase connection issue.');
    console.error('   - Ensure Supabase is running: supabase start');
    console.error('   - Verify PUBLIC_SUPABASE_URL points to a running instance');
    console.error('   - Check network connectivity');
  } else if (errorMessage.includes('401') || errorMessage.includes('403') || errorMessage.includes('Unauthorized')) {
    console.error('\n💡 Hint: Authentication error.');
    console.error('   - Verify SUPABASE_SERVICE_ROLE_KEY is correct');
    console.error('   - Check that the service role key matches your Supabase instance');
  } else if (errorMessage.includes('listAllAuthUsers')) {
    console.error('\n💡 Hint: Error fetching users from Supabase.');
    console.error('   - Check Supabase connection and service role key');
    console.error('   - Verify auth schema is properly set up');
  }

  process.exitCode = 1;
});
