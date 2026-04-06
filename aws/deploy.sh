#!/bin/bash
# Deploy SAM stack using values from ../.env.local
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env.local"

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: .env.local not found at $ENV_FILE"
  exit 1
fi

# Source env vars (without expanding globs or splitting)
while IFS='=' read -r key value; do
  # Skip comments and empty lines
  [[ -z "$key" || "$key" == \#* ]] && continue
  export "$key=$value"
done < "$ENV_FILE"

# Use prod Supabase values
SUPABASE_URL="${SUPABASE_URL_PROD:?SUPABASE_URL_PROD not set in .env.local}"
SUPABASE_SECRET_KEY="${SUPABASE_SECRET_KEY_PROD:?SUPABASE_SECRET_KEY_PROD not set in .env.local}"

# Build first
npm run build

# Deploy from aws/ dir so samconfig.toml is picked up
cd "$SCRIPT_DIR"
sam deploy \
  --parameter-overrides \
    SupabaseUrl="$SUPABASE_URL" \
    SupabaseSecretKey="$SUPABASE_SECRET_KEY" \
    SiteUrl="https://stocktextalerts.com" \
    MassiveApiKey="$MASSIVE_API_KEY" \
    FinnhubApiKey="$FINNHUB_API_KEY" \
    XaiApiKey="$XAI_API_KEY" \
    EmailFrom="$EMAIL_FROM" \
    TwilioAccountSid="$TWILIO_ACCOUNT_SID" \
    TwilioAuthToken="$TWILIO_AUTH_TOKEN" \
    TwilioPhoneNumber="$TWILIO_PHONE_NUMBER" \
    UnsubscribeTokenSecret="$UNSUBSCRIBE_TOKEN_SECRET" \
    LogMaskPii="true"
