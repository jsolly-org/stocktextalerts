#!/bin/bash
# Generate env.json for sam local invoke from ../.env.local
# Each function gets only the env vars it actually needs (least-privilege).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env.local"

if [ ! -f "$ENV_FILE" ]; then
  echo "Error: .env.local not found at $ENV_FILE"
  exit 1
fi

# Source env vars
while IFS='=' read -r key value; do
  [[ -z "$key" || "$key" == \#* ]] && continue
  export "$key=$value"
done < "$ENV_FILE"

# Use prod Supabase values
SUPABASE_URL="${SUPABASE_URL_PROD:?SUPABASE_URL_PROD not set in .env.local}"
SUPABASE_SECRET_KEY="${SUPABASE_SECRET_KEY_PROD:?SUPABASE_SECRET_KEY_PROD not set in .env.local}"

cat > "$SCRIPT_DIR/env.json" <<ENDJSON
{
  "ScheduleFunction": {
    "SUPABASE_URL": "$SUPABASE_URL",
    "SUPABASE_SECRET_KEY": "$SUPABASE_SECRET_KEY",
    "SITE_URL": "https://stocktextalerts.com",
    "MASSIVE_API_KEY": "$MASSIVE_API_KEY",
    "FINNHUB_API_KEY": "$FINNHUB_API_KEY",
    "XAI_API_KEY": "${XAI_API_KEY:-}",
    "RESEND_API_KEY": "$RESEND_API_KEY",
    "EMAIL_FROM": "StockTextAlerts <notifications@stocktextalerts.com>",
    "TWILIO_ACCOUNT_SID": "$TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN": "$TWILIO_AUTH_TOKEN",
    "TWILIO_PHONE_NUMBER": "$TWILIO_PHONE_NUMBER",
    "UNSUBSCRIBE_TOKEN_SECRET": "$UNSUBSCRIBE_TOKEN_SECRET"
  },
  "AssetEventsFunction": {
    "SUPABASE_URL": "$SUPABASE_URL",
    "SUPABASE_SECRET_KEY": "$SUPABASE_SECRET_KEY",
    "MASSIVE_API_KEY": "$MASSIVE_API_KEY",
    "FINNHUB_API_KEY": "$FINNHUB_API_KEY"
  },
  "ComputeDailyStatsFunction": {
    "SUPABASE_URL": "$SUPABASE_URL",
    "SUPABASE_SECRET_KEY": "$SUPABASE_SECRET_KEY",
    "MASSIVE_API_KEY": "$MASSIVE_API_KEY"
  }
}
ENDJSON

echo "Generated env.json with per-function env vars"
