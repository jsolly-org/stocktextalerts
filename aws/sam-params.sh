#!/usr/bin/env bash
# Source this script to export SAM_PARAMS from ../.env.local.
#
# Used by deploy.sh and sam-local.sh so the same parameter mapping feeds both the
# prod deploy and the local container-invoke paths, rather than duplicating the
# env.local -> SAM parameter translation in two places.
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
: "${TWILIO_API_KEY_SID:?TWILIO_API_KEY_SID not set in .env.local}"
: "${TWILIO_API_KEY_SECRET:?TWILIO_API_KEY_SECRET not set in .env.local}"
: "${TWILIO_PHONE_NUMBER:?TWILIO_PHONE_NUMBER not set in .env.local}"
: "${UNSUBSCRIBE_TOKEN_SECRET:?UNSUBSCRIBE_TOKEN_SECRET not set in .env.local}"
: "${EMAIL_DISPATCH_SECRET:?EMAIL_DISPATCH_SECRET not set in .env.local}"
: "${ADMIN_EMAILS:?ADMIN_EMAILS not set in .env.local}"
: "${PRODUCTION_SITE_URL:?PRODUCTION_SITE_URL not set in .env.local}"

_GIT_SHA="$(git -C "$_PARAMS_DIR/.." rev-parse --short HEAD 2>/dev/null || echo unknown)"

SAM_PARAMS=(
  "AlertTopicArn=/shared-infra/alert-topic-arn"
  "SupabaseUrl=$SUPABASE_URL_PROD"
  "SupabaseSecretKey=$SUPABASE_SECRET_KEY_PROD"
  "SiteUrl=$PRODUCTION_SITE_URL"
  "MassiveApiKey=$MASSIVE_API_KEY"
  "FinnhubApiKey=$FINNHUB_API_KEY"
  "XaiApiKey=${XAI_API_KEY:-}"
  "TwilioAccountSid=$TWILIO_ACCOUNT_SID"
  "TwilioApiKeySid=$TWILIO_API_KEY_SID"
  "TwilioApiKeySecret=$TWILIO_API_KEY_SECRET"
  "TwilioPhoneNumber=$TWILIO_PHONE_NUMBER"
  "UnsubscribeTokenSecret=$UNSUBSCRIBE_TOKEN_SECRET"
  "EmailDispatchSecret=$EMAIL_DISPATCH_SECRET"
  "AdminEmails=$ADMIN_EMAILS"
  "LogMaskPii=${LOG_MASK_PII:-true}"
  "GitSha=$_GIT_SHA"
)
export SAM_PARAMS
