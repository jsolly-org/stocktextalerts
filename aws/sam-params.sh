#!/usr/bin/env bash
# Source this script to export SAM_PARAMS from ../.env.local.
#
# Used by deploy.sh (sam deploy) and sam-local.sh (sam local invoke) so the
# same parameter mapping feeds both prod deploys and local container runs.
# Keeping this as one shell helper avoids duplicating the env.local -> SAM
# parameter translation in multiple places.
set -euo pipefail

_PARAMS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_ENV_FILE="${ENV_FILE:-$_PARAMS_DIR/../.env.local}"

if [ ! -f "$_ENV_FILE" ]; then
  echo "Error: .env.local not found at $_ENV_FILE" >&2
  exit 1
fi

# shellcheck disable=SC2163
while IFS='=' read -r _key _value; do
  [[ -z "$_key" || "$_key" == \#* ]] && continue
  export "$_key=$_value"
done < "$_ENV_FILE"

: "${SUPABASE_URL_PROD:?SUPABASE_URL_PROD not set in .env.local}"
: "${SUPABASE_SECRET_KEY_PROD:?SUPABASE_SECRET_KEY_PROD not set in .env.local}"
: "${MASSIVE_API_KEY:?MASSIVE_API_KEY not set in .env.local}"
: "${FINNHUB_API_KEY:?FINNHUB_API_KEY not set in .env.local}"
: "${TWILIO_ACCOUNT_SID:?TWILIO_ACCOUNT_SID not set in .env.local}"
: "${TWILIO_AUTH_TOKEN:?TWILIO_AUTH_TOKEN not set in .env.local}"
: "${TWILIO_PHONE_NUMBER:?TWILIO_PHONE_NUMBER not set in .env.local}"
: "${UNSUBSCRIBE_TOKEN_SECRET:?UNSUBSCRIBE_TOKEN_SECRET not set in .env.local}"

_GIT_SHA="$(git -C "$_PARAMS_DIR/.." rev-parse --short HEAD 2>/dev/null || echo unknown)"

SAM_PARAMS=(
  "SupabaseUrl=$SUPABASE_URL_PROD"
  "SupabaseSecretKey=$SUPABASE_SECRET_KEY_PROD"
  "SiteUrl=https://stocktextalerts.com"
  "MassiveApiKey=$MASSIVE_API_KEY"
  "FinnhubApiKey=$FINNHUB_API_KEY"
  "XaiApiKey=${XAI_API_KEY:-}"
  "EmailFrom=StockTextAlerts <notifications@stocktextalerts.com>"
  "TwilioAccountSid=$TWILIO_ACCOUNT_SID"
  "TwilioAuthToken=$TWILIO_AUTH_TOKEN"
  "TwilioPhoneNumber=$TWILIO_PHONE_NUMBER"
  "UnsubscribeTokenSecret=$UNSUBSCRIBE_TOKEN_SECRET"
  "LogMaskPii=${LOG_MASK_PII:-true}"
  "GitSha=$_GIT_SHA"
)
export SAM_PARAMS
