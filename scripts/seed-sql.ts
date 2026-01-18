import type { TablesInsert } from "../src/lib/generated/database.types";

type DbUserInsert = TablesInsert<"users">;

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

function sqlNullableString(value: string | null | undefined): string {
  if (value === null || value === undefined) return 'NULL';
  const trimmed = value.trim();
  if (!trimmed) return 'NULL';
  return `'${escapeSql(trimmed)}'`;
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
  const userEmailRaw = user.email.trim();
  const email = escapeSql(userEmailRaw);
  const timezoneRaw = (user.timezone ?? "").trim();
  const timezone = escapeSql(timezoneRaw || "America/New_York");

  const dailyDigestEnabled = user.daily_digest_enabled ?? true;
  const dailyDigestNotificationTime = user.daily_digest_notification_time ?? 540;
  const phoneVerified = user.phone_verified ?? false;
  const smsOptedOut = user.sms_opted_out ?? false;
  const emailNotificationsEnabled = user.email_notifications_enabled ?? false;
  const smsNotificationsEnabled = user.sms_notifications_enabled ?? false;

  const phoneCountryCodeRaw = user.phone_country_code ?? null;
  const phoneNumberRaw = user.phone_number ?? null;
  const phoneCountryCode =
    phoneCountryCodeRaw && phoneNumberRaw ? phoneCountryCodeRaw : null;
  const phoneNumber = phoneCountryCodeRaw && phoneNumberRaw ? phoneNumberRaw : null;

  return `
INSERT INTO public.users (
  id,
  email,
  phone_country_code,
  phone_number,
  phone_verified,
  sms_opted_out,
  timezone,
  daily_digest_enabled,
  daily_digest_notification_time,
  email_notifications_enabled,
  sms_notifications_enabled
) VALUES (
  '${userId}'::uuid,
  '${email}',
  ${sqlNullableString(phoneCountryCode)},
  ${sqlNullableString(phoneNumber)},
  ${phoneVerified},
  ${smsOptedOut},
  '${timezone}',
  ${dailyDigestEnabled},
  ${dailyDigestNotificationTime},
  ${emailNotificationsEnabled},
  ${smsNotificationsEnabled}
)
ON CONFLICT (id) DO UPDATE SET
  email = EXCLUDED.email,
  phone_country_code = EXCLUDED.phone_country_code,
  phone_number = EXCLUDED.phone_number,
  phone_verified = EXCLUDED.phone_verified,
  sms_opted_out = EXCLUDED.sms_opted_out,
  timezone = EXCLUDED.timezone,
  daily_digest_enabled = EXCLUDED.daily_digest_enabled,
  daily_digest_notification_time = EXCLUDED.daily_digest_notification_time,
  email_notifications_enabled = EXCLUDED.email_notifications_enabled,
  sms_notifications_enabled = EXCLUDED.sms_notifications_enabled;
`;
}

export function buildUserStocksSql(userId: string, trackedStocks: string[]): string {
  if (trackedStocks.length === 0) return '';

  const stocksValues = trackedStocks
    .map((symbol) => `UPPER(TRIM('${escapeSql(symbol)}'))`)
    .join(', ');

  return `
INSERT INTO public.user_stocks (user_id, symbol)
SELECT
  '${userId}'::uuid,
  s.symbol
FROM (
  SELECT symbol FROM public.stocks WHERE UPPER(TRIM(symbol)) IN (${stocksValues})
) s
ON CONFLICT (user_id, symbol) DO NOTHING;
`;
}

