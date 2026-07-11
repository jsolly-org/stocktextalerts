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
  # Skip AWS_* credential/region selectors. .env.local sets AWS_PROFILE=fleet-deploy for the
  # code-only pre-push deploy, but this full infra deploy must run under the operator's admin
  # session — importing fleet-deploy here silently forces sam onto the scoped agent-deploy role
  # and it fails closed on cloudformation:CreateChangeSet. SAM still reads creds from the
  # operator's environment/SSO.
  [[ "$_key" == AWS_* ]] && continue
  export "$_key=$_value"
done < "$_ENV_FILE"

# Secrets are NO LONGER passed as SAM params — each Lambda fetches them at runtime
# from SSM SecureString (see aws/template.yaml + src/lib/secrets.ts). The
# SecureStrings (${SSM_PREFIX:-/stocktextalerts}/<kebab-name>) are provisioned out of band:
#   aws ssm put-parameter --type SecureString --key-id alias/aws/ssm --overwrite \
#     --region us-east-1 --name <ssm-prefix>/<kebab> --value <secret>
# Only the non-secret template params remain here. Defaults match current production;
# forks override via .env.local (SES_IDENTITY_DOMAIN, SSM_PREFIX, ALERT_TOPIC_SSM_PARAM, …).
: "${ADMIN_EMAILS:?ADMIN_EMAILS not set in .env.local}"
: "${PRODUCTION_SITE_URL:?PRODUCTION_SITE_URL not set in .env.local}"

_SSM_PREFIX="${SSM_PREFIX:-/stocktextalerts}"

SAM_PARAMS=(
  "SiteUrl=$PRODUCTION_SITE_URL"
  "AdminEmails=$ADMIN_EMAILS"
  "LogMaskPii=${LOG_MASK_PII:-true}"
  "SesIdentityDomain=${SES_IDENTITY_DOMAIN:-stocktextalerts.com}"
  "SsmPrefix=$_SSM_PREFIX"
  "AlertTopicArn=${ALERT_TOPIC_SSM_PARAM:-/shared-infra/alert-topic-arn}"
  "EmailFrom=${EMAIL_FROM_SSM_PARAM:-$_SSM_PREFIX/email-from}"
  "BackupConnectionSsmParam=${BACKUP_CONNECTION_SSM_PARAM:-$_SSM_PREFIX/backup/connection-string}"
)
export SAM_PARAMS
