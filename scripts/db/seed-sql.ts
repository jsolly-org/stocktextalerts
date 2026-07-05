import { NOTIFICATION_PREFERENCE_CATALOG } from "../../src/lib/constants";
import type { TablesInsert } from "../../src/lib/db/generated/database.types";

type DbUserInsert = Omit<TablesInsert<"users">, "market_scheduled_asset_price_times"> & {
  market_scheduled_asset_price_times?: number[] | null;
};

export type SeedUser = Omit<Partial<DbUserInsert>, "email"> & {
  email: DbUserInsert["email"];
  password?: string;
  tracked_assets?: string[];
  // Per-option channel facets now live in notification_preferences, not on `users`.
  // Seed JSON may still set the scheduled-market facets; emitted as table rows.
  market_scheduled_asset_price_include_email?: boolean;
};

/**
 * Escapes single quotes for SQL string literals.
 * WARNING: Only use with trusted data in seed scripts.
 * For production code, use parameterized queries instead.
 */
export function escapeSql(str: string): string {
  return str.replace(/'/g, "''");
}

/**
 * Validate a timezone identifier for the `users.timezone` field.
 *
 * Defaults to "America/New_York" when omitted.
 */
function validateTimezone(value: unknown, fieldName: string): string {
  if (value === null || value === undefined) {
    return "America/New_York";
  }
  if (typeof value !== "string") {
    throw new Error(
      `Seed user: ${fieldName} must be a string. Received: ${typeof value}`,
    );
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(
      `Seed user: ${fieldName} cannot be an empty string. Use null/undefined for default or provide a valid timezone.`,
    );
  }
  if (/\s/.test(trimmed)) {
    throw new Error(
      `Seed user: ${fieldName} cannot contain whitespace. Received: "${trimmed}"`,
    );
  }
  return trimmed;
}

/**
 * Validate an optional boolean field from seed JSON.
 *
 * Returns `undefined` when absent; throws when present but invalid.
 */
function validateOptionalBoolean(
  value: unknown,
  fieldName: string,
): boolean | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(
      `Seed user: ${fieldName} must be a boolean, null, or undefined. Received: ${typeof value}`,
    );
  }
  return value;
}


/**
 * Validate an optional number array field from seed JSON.
 *
 * Returns `undefined` when absent; throws when present but invalid.
 */
function validateOptionalNumberArray(
  value: unknown,
  fieldName: string,
): number[] | undefined {
  if (value === null || value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(
      `Seed user: ${fieldName} must be an array, null, or undefined. Received: ${typeof value}`,
    );
  }
  for (const entry of value) {
    if (typeof entry !== "number" || Number.isNaN(entry) || !Number.isFinite(entry)) {
      throw new Error(
        `Seed user: ${fieldName} must contain only finite numbers. Received: ${String(entry)}`,
      );
    }
  }
  return value;
}

/**
 * Build a SQL block that ensures an auth user exists.
 *
 * This targets `auth.users` and only inserts if the user id is not present.
 */
export function buildAuthUserSql(userId: string, email: string, password: string): string {
  const escapedEmail = escapeSql(email);
  const escapedPassword = escapeSql(password);

  return `
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = '${userId}'::uuid) THEN
    INSERT INTO auth.users (
      instance_id,
      id,
      aud,
      role,
      email,
      encrypted_password,
      email_confirmed_at,
      recovery_sent_at,
      last_sign_in_at,
      raw_app_meta_data,
      raw_user_meta_data,
      created_at,
      updated_at,
      confirmation_token,
      email_change,
      email_change_token_new,
      recovery_token
    ) VALUES (
      '00000000-0000-0000-0000-000000000000'::uuid,
      '${userId}'::uuid,
      'authenticated',
      'authenticated',
      '${escapedEmail}',
      crypt('${escapedPassword}', gen_salt('bf')),
      now(),
      now(),
      now(),
      '{"provider":"email","providers":["email"]}',
      '{}',
      now(),
      now(),
      '',
      '',
      '',
      ''
    );
  END IF;
END $$;
`;
}

/**
 * Build SQL to ensure an `auth.identities` row exists for a user.
 *
 * The INSERT is guarded with `WHERE NOT EXISTS` to be idempotent.
 */
export function buildAuthIdentitySql(userId: string, email: string): string {
  const escapedEmail = escapeSql(email);

  return `
INSERT INTO auth.identities (
  id,
  user_id,
  identity_data,
  provider,
  provider_id,
  last_sign_in_at,
  created_at,
  updated_at
)
SELECT
  gen_random_uuid(),
  '${userId}'::uuid,
  jsonb_build_object('sub', '${userId}', 'email', '${escapedEmail}')::jsonb,
  'email',
  '${userId}',
  now(),
  now(),
  now()
WHERE NOT EXISTS (
    SELECT 1 FROM auth.identities WHERE user_id = '${userId}'::uuid
);
`;
}

/**
 * Build SQL to upsert a row into `public.users` from seed input.
 *
 * Validates and normalizes fields and only includes optional columns when provided.
 */
export function buildPublicUserSql(userId: string, user: SeedUser): string {
  if (typeof user.email !== "string") {
    throw new Error(
      `Seed user: email must be a string. Received: ${typeof user.email}`,
    );
  }
  const userEmailRaw = user.email.trim();
  if (!userEmailRaw) {
    throw new Error("Seed user: email cannot be empty or whitespace-only.");
  }
  if (/\s/.test(userEmailRaw)) {
    throw new Error(
      `Seed user: email cannot contain whitespace. Received: "${userEmailRaw}"`,
    );
  }
  const email = escapeSql(userEmailRaw);

  const timezoneRaw = validateTimezone(user.timezone, "timezone");
  const timezone = escapeSql(timezoneRaw);

  const insertColumns: string[] = ["id", "email", "timezone", "approved_at", "approved_by"];
  const insertValues: string[] = [
    `'${userId}'::uuid`,
    `'${email}'`,
    `'${timezone}'`,
    "now()",
    "'seed'",
  ];
  const updateFields: string[] = [
    "email = EXCLUDED.email",
    "timezone = EXCLUDED.timezone",
    "approved_at = EXCLUDED.approved_at",
    "approved_by = EXCLUDED.approved_by",
  ];

  const scheduledUpdateTimes = validateOptionalNumberArray(
    user.market_scheduled_asset_price_times,
    "market_scheduled_asset_price_times",
  );
  if (scheduledUpdateTimes !== undefined) {
    if (scheduledUpdateTimes.length === 0) {
      throw new Error(
        "Seed user: market_scheduled_asset_price_times cannot be an empty array.",
      );
    }
    for (const entry of scheduledUpdateTimes) {
      if (entry < 0 || entry > 1439) {
        throw new Error(
          `Seed user: market_scheduled_asset_price_times entries must be between 0 and 1439. Received: ${entry}`,
        );
      }
    }
    insertColumns.push("market_scheduled_asset_price_times");
    insertValues.push(`ARRAY[${scheduledUpdateTimes.join(", ")}]`);
    updateFields.push(
      "market_scheduled_asset_price_times = EXCLUDED.market_scheduled_asset_price_times",
    );
  }

  const emailNotificationsEnabled = validateOptionalBoolean(
    user.email_notifications_enabled,
    "email_notifications_enabled",
  );
  if (emailNotificationsEnabled !== undefined) {
    insertColumns.push("email_notifications_enabled");
    insertValues.push(String(emailNotificationsEnabled));
    updateFields.push("email_notifications_enabled = EXCLUDED.email_notifications_enabled");
  }

  const usersSql = `
INSERT INTO public.users (
  ${insertColumns.join(",\n  ")}
) VALUES (
  ${insertValues.join(",\n  ")}
)
ON CONFLICT (id) DO UPDATE SET
  ${updateFields.join(",\n  ")};
`;

  // Per-option channel preferences are the single source of truth in
  // notification_preferences (no per-column flags on `users`). Seed the default row
  // set for every user, then override the scheduled-market facets from seed JSON.
  return usersSql + buildNotificationPreferencesSql(userId, user);
}

/** New-user default preference rows, derived from the authored option catalog. */
const SEED_DEFAULT_PREFERENCE_ROWS = NOTIFICATION_PREFERENCE_CATALOG.map((entry) => ({
  notification_type: entry.notification_type,
  content: entry.content,
  channel: entry.channel,
  enabled: entry.default,
}));

/** Build the notification_preferences seed for a user: default rows + JSON overrides. */
function buildNotificationPreferencesSql(userId: string, user: SeedUser): string {
  const overrides = new Map<string, boolean>();
  const scheduledEmail = validateOptionalBoolean(
    user.market_scheduled_asset_price_include_email,
    "market_scheduled_asset_price_include_email",
  );
  if (scheduledEmail !== undefined) {
    overrides.set("market_scheduled_asset_price||email", scheduledEmail);
  }
  // override key = `${notification_type}|${content}|${channel}`; content is "" for market types.

  const rows = SEED_DEFAULT_PREFERENCE_ROWS.map((row) => {
    const enabled =
      overrides.get(`${row.notification_type}|${row.content}|${row.channel}`) ?? row.enabled;
    return `('${userId}'::uuid, '${row.notification_type}', '${escapeSql(row.content)}', '${row.channel}'::public.delivery_method, ${enabled})`;
  });

  return `
INSERT INTO public.notification_preferences (user_id, notification_type, content, channel, enabled) VALUES
  ${rows.join(",\n  ")}
ON CONFLICT (user_id, notification_type, content, channel) DO UPDATE SET
  enabled = EXCLUDED.enabled;
`;
}

/**
 * Build SQL to insert tracked assets into `public.user_assets` for a user.
 *
 * Uses `ON CONFLICT DO NOTHING` so it can be safely re-run.
 */
export function buildUserAssetsSql(userId: string, trackedAssets: string[]): string {
  if (trackedAssets.length === 0) return '';

  const assetsValues = trackedAssets
    .map((symbol) => `'${escapeSql(symbol)}'`)
    .join(', ');

  return `
INSERT INTO public.user_assets (user_id, symbol)
SELECT
  '${userId}'::uuid,
  s.symbol
FROM (
  SELECT symbol FROM public.assets WHERE symbol IN (${assetsValues})
) s
ON CONFLICT (user_id, symbol) DO NOTHING;
`;
}
