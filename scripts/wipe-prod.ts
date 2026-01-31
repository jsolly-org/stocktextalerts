import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { rootLogger } from "../src/lib/logging";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");

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
  let page = 1;
  let deleted = 0;

  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
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

    if (users.length < perPage) break;
    page += 1;
  }

  rootLogger.info("Deleted auth users from production.", {
    context: { deleted },
  });
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
    context: { deletedBuckets, deletedObjects },
  });
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  const supabaseUrl = process.env.PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL must be set in .env.local");
  }
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      "PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local",
    );
  }

  rootLogger.info("Wiping production public schema.", {
    context: { databaseUrlHost: new URL(databaseUrl).host },
  });

  execFileSync(
    "psql",
    ["-v", "ON_ERROR_STOP=1", "-c", WIPE_PUBLIC_SQL, databaseUrl],
    { stdio: "inherit" },
  );

  await deleteAllAuthUsers(supabaseUrl, serviceRoleKey);
  await deleteAllStorage(supabaseUrl, serviceRoleKey);
}

main();
