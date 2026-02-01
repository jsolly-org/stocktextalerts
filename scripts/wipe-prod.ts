import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { rootLogger } from "../src/lib/logging";

type ParsedDatabaseUrl = {
  host: string;
  port: string;
  dbname: string;
  username: string;
  password: string;
};

function escapePgpassField(s: string): string {
  return s.replace(/[:\\]/g, "\\$&");
}

function parseDatabaseUrl(url: string): ParsedDatabaseUrl {
  const u = new URL(url);
  const dbname = u.pathname.slice(1) || "postgres";
  const port = u.port || "5432";
  return {
    host: u.hostname,
    port,
    dbname,
    username: u.username || "postgres",
    password: u.password,
  };
}

function runPsqlWithParsedUrl(parsed: ParsedDatabaseUrl, sql: string): void {
  const pgpassDir = fs.mkdtempSync(path.join(os.tmpdir(), "wipe-prod-"));
  const pgpassPath = path.join(pgpassDir, ".pgpass");
  try {
    const line = [
      escapePgpassField(parsed.host),
      escapePgpassField(parsed.port),
      escapePgpassField(parsed.dbname),
      escapePgpassField(parsed.username),
      escapePgpassField(parsed.password),
    ].join(":");
    fs.writeFileSync(pgpassPath, `${line}\n`, { mode: 0o600 });
    execFileSync(
      "psql",
      [
        "-v",
        "ON_ERROR_STOP=1",
        "-h",
        parsed.host,
        "-p",
        parsed.port,
        "-U",
        parsed.username,
        "-d",
        parsed.dbname,
        "-c",
        sql,
      ],
      {
        stdio: "inherit",
        env: { ...process.env, PGPASSFILE: pgpassPath },
      },
    );
  } finally {
    fs.rmSync(pgpassDir, { recursive: true });
  }
}

const WIPE_PUBLIC_SQL = `
BEGIN;

-- Drop and recreate public to remove all app objects.
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
COMMIT;
`;

type StorageItem = {
  id?: string | null;
  name: string;
};

function createAdminClient(supabaseUrl: string, serviceRoleKey: string) {
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function deleteAllAuthUsers(
  supabaseUrl: string,
  serviceRoleKey: string,
) {
  const supabase = createAdminClient(supabaseUrl, serviceRoleKey);

  const perPage = 1000;
  let deleted = 0;

  while (true) {
    // Always fetch page 1: deleting users shifts pagination offsets.
    const { data, error } = await supabase.auth.admin.listUsers({
      page: 1,
      perPage,
    });
    if (error) {
      throw error;
    }

    const users = data.users ?? [];
    if (users.length === 0) break;

    for (const user of users) {
      const { error: deleteError } = await supabase.auth.admin.deleteUser(user.id);
      if (deleteError) {
        throw deleteError;
      }
      deleted += 1;
    }
  }

  rootLogger.info("Deleted auth users from production.", { deleted });
}

async function listAllObjects(
  supabase: ReturnType<typeof createAdminClient>,
  bucket: string,
  prefix: string,
  collected: string[],
) {
  let offset = 0;
  const limit = 1000;

  while (true) {
    const { data, error } = await supabase.storage
      .from(bucket)
      .list(prefix, { limit, offset });
    if (error) {
      throw error;
    }

    if (!data || data.length === 0) break;

    for (const item of data as StorageItem[]) {
      const path = prefix ? `${prefix}/${item.name}` : item.name;
      if (!item.id) {
        await listAllObjects(supabase, bucket, path, collected);
        continue;
      }
      collected.push(path);
    }

    if (data.length < limit) break;
    offset += limit;
  }
}

async function deleteAllStorage(supabaseUrl: string, serviceRoleKey: string) {
  const supabase = createAdminClient(supabaseUrl, serviceRoleKey);

  const { data: buckets, error: bucketsError } =
    await supabase.storage.listBuckets();
  if (bucketsError) {
    throw bucketsError;
  }

  let deletedObjects = 0;
  let deletedBuckets = 0;

  for (const bucket of buckets ?? []) {
    const paths: string[] = [];
    await listAllObjects(supabase, bucket.name, "", paths);

    if (paths.length > 0) {
      const { error: removeError } = await supabase.storage
        .from(bucket.name)
        .remove(paths);
      if (removeError) {
        throw removeError;
      }
      deletedObjects += paths.length;
    }

    const { error: deleteError } = await supabase.storage.deleteBucket(
      bucket.name,
    );
    if (deleteError) {
      throw deleteError;
    }
    deletedBuckets += 1;
  }

  rootLogger.info("Deleted storage buckets from production.", {
    deletedBuckets,
    deletedObjects,
  });
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL!;
  const supabaseUrl = process.env.PUBLIC_SUPABASE_URL!;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

  new URL(supabaseUrl); // format validation

  const parsed = parseDatabaseUrl(databaseUrl);

  rootLogger.info("Wiping production public schema.", {
    databaseUrlHost: parsed.host,
  });

  runPsqlWithParsedUrl(parsed, WIPE_PUBLIC_SQL);

  await deleteAllAuthUsers(supabaseUrl, serviceRoleKey);
  await deleteAllStorage(supabaseUrl, serviceRoleKey);
}

main().catch((error) => {
  rootLogger.error(
    "❌ Error wiping production database.",
    { action: "wipe_prod" },
    error,
  );
  process.exitCode = 1;
});
