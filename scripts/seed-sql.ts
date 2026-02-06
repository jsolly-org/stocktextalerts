import type { TablesInsert } from "../src/lib/db/generated/database.types";

type DbUserInsert = Omit<TablesInsert<"users">, "scheduled_update_time"> & {
  scheduled_update_times?: number[] | null;
};

export type SeedUser = Omit<Partial<DbUserInsert>, "email"> & {
  email: DbUserInsert["email"];
  password?: string;
  tracked_stocks?: string[];
};

/**
 * Escapes single quotes for SQL string literals.
 * WARNING: Only use with trusted data in seed scripts.
 * For production code, use parameterized queries instead.
 */
export function escapeSql(str: string): string {
  return str.replace(/'/g, "''");
}

// Seed inputs come from local JSON; normalize whitespace since DB constraints
// do not apply to auth.users and the seed data is sourced from external JSON.
function sqlNullableString(value: string | null | undefined): string {
  if (value === null || value === undefined) return 'NULL';
  const trimmed = value.trim();
  if (!trimmed) return 'NULL';
  return `'${escapeSql(trimmed)}'`;
}

function sqlString(value: string): string {
  const trimmed = value.trim();
  return `'${escapeSql(trimmed)}'`;
}

function validateOptionalString(
  value: unknown,
  fieldName: string,
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new Error(
      `Seed user: ${fieldName} must be a string, null, or undefined. Received: ${typeof value}`,
    );
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(
      `Seed user: ${fieldName} cannot be an empty string. Use null to omit the field.`,
    );
  }
  return trimmed;
}

function validatePhoneCountryCode(value: unknown, fieldName: string): string | null {
  const validated = validateOptionalString(value, fieldName);
  if (validated === null) return null;
  
  if (!/^\+[0-9]{1,4}$/.test(validated)) {
    throw new Error(
      `Seed user: ${fieldName} must match format ^\\+[0-9]{1,4}$ (e.g., "+1", "+44"). Received: "${validated}"`,
    );
  }
  
  return validated;
}

function validatePhoneNumber(value: unknown, fieldName: string): string | null {
  const validated = validateOptionalString(value, fieldName);
  if (validated === null) return null;
  
  if (!/^[0-9]{10,14}$/.test(validated)) {
    throw new Error(
      `Seed user: ${fieldName} must match format ^[0-9]{10,14}$ (10-14 digits). Received: "${validated}"`,
    );
  }
  
  return validated;
}

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

function validateOptionalNumber(
  value: unknown,
  fieldName: string,
): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "number") {
    throw new Error(
      `Seed user: ${fieldName} must be a number, null, or undefined. Received: ${typeof value}`,
    );
  }
  if (Number.isNaN(value) || !Number.isFinite(value)) {
    throw new Error(
      `Seed user: ${fieldName} must be a finite number. Received: ${value}`,
    );
  }
  return value;
}

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

  const phoneCountryCode = validatePhoneCountryCode(
    user.phone_country_code,
    "phone_country_code",
  );
  const phoneNumber = validatePhoneNumber(user.phone_number, "phone_number");

  const insertColumns: string[] = ["id", "email", "timezone"];
  const insertValues: string[] = [`'${userId}'::uuid`, `'${email}'`, `'${timezone}'`];
  const updateFields: string[] = ["email = EXCLUDED.email", "timezone = EXCLUDED.timezone"];

  if ((phoneCountryCode === null) !== (phoneNumber === null)) {
    throw new Error(
      "Seed user: phone_country_code and phone_number must both be provided or both be omitted.",
    );
  }

  if (phoneCountryCode !== null && phoneNumber !== null) {
    insertColumns.push("phone_country_code", "phone_number");
    insertValues.push(sqlString(phoneCountryCode), sqlString(phoneNumber));
    updateFields.push("phone_country_code = EXCLUDED.phone_country_code", "phone_number = EXCLUDED.phone_number");
  }

  const phoneVerified = validateOptionalBoolean(user.phone_verified, "phone_verified");
  if (phoneVerified !== undefined) {
    insertColumns.push("phone_verified");
    insertValues.push(String(phoneVerified));
    updateFields.push("phone_verified = EXCLUDED.phone_verified");
  }

  const scheduledUpdatesEnabled = validateOptionalBoolean(
    user.scheduled_updates_enabled,
    "scheduled_updates_enabled",
  );
  if (scheduledUpdatesEnabled !== undefined) {
    insertColumns.push("scheduled_updates_enabled");
    insertValues.push(String(scheduledUpdatesEnabled));
    updateFields.push("scheduled_updates_enabled = EXCLUDED.scheduled_updates_enabled");
  }

  const scheduledUpdateTimes = validateOptionalNumberArray(
    user.scheduled_update_times,
    "scheduled_update_times",
  );
  if (scheduledUpdateTimes !== undefined) {
    if (scheduledUpdateTimes.length === 0) {
      throw new Error(
        "Seed user: scheduled_update_times cannot be an empty array.",
      );
    }
    for (const entry of scheduledUpdateTimes) {
      if (entry < 0 || entry > 1439 || entry % 15 !== 0) {
        throw new Error(
          `Seed user: scheduled_update_times entries must be between 0 and 1439 and divisible by 15. Received: ${entry}`,
        );
      }
    }
    insertColumns.push("scheduled_update_times");
    insertValues.push(`ARRAY[${scheduledUpdateTimes.join(", ")}]`);
    updateFields.push(
      "scheduled_update_times = EXCLUDED.scheduled_update_times",
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

  const smsNotificationsEnabled = validateOptionalBoolean(
    user.sms_notifications_enabled,
    "sms_notifications_enabled",
  );
  if (smsNotificationsEnabled !== undefined) {
    insertColumns.push("sms_notifications_enabled");
    insertValues.push(String(smsNotificationsEnabled));
    updateFields.push("sms_notifications_enabled = EXCLUDED.sms_notifications_enabled");
  }

  return `
INSERT INTO public.users (
  ${insertColumns.join(",\n  ")}
) VALUES (
  ${insertValues.join(",\n  ")}
)
ON CONFLICT (id) DO UPDATE SET
  ${updateFields.join(",\n  ")};
`;
}

export function buildUserStocksSql(userId: string, trackedStocks: string[]): string {
  if (trackedStocks.length === 0) return '';

  const stocksValues = trackedStocks
    .map((symbol) => `'${escapeSql(symbol)}'`)
    .join(', ');

  return `
INSERT INTO public.user_stocks (user_id, symbol)
SELECT
  '${userId}'::uuid,
  s.symbol
FROM (
  SELECT symbol FROM public.stocks WHERE symbol IN (${stocksValues})
) s
ON CONFLICT (user_id, symbol) DO NOTHING;
`;
}

