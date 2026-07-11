# Self-hosting / production bootstrap

This guide is for standing up your own StockTextAlerts stack. Angle brackets like `<your-domain>` are placeholders — replace them with real values. Do not commit secrets.

After bootstrap, day-to-day releases are mostly automated (merge to `main`). The steps below are the **manual** ones CI will not do for you.

## Architecture (what runs where)

| Piece | Platform |
| --- | --- |
| Dashboard + APIs + Telegram webhook | Vercel (Astro SSR) |
| Auth + Postgres | Supabase |
| Notification crons, email send, charts | AWS Lambda (SAM stack) |
| Secrets for Lambdas | AWS SSM SecureString under `<ssm-prefix>/…` |
| Migrations + Lambda code updates | GitHub Actions `deploy.yml` on push to `main` |

Web deploy (Vercel Git) and the GitHub deploy workflow run **in parallel** on `main` pushes — deploy is not gated on the post-merge CI canary.

## 1. Accounts and domain

| Need | Why |
| --- | --- |
| Domain + DNS | HTTPS site URL for Vercel + Telegram webhook |
| AWS account | Lambdas, SES, SSM, EventBridge (template defaults assume a region you set in `samconfig`) |
| Supabase project | Auth + database |
| Vercel project linked to the GitHub repo | Web deploys |
| Massive API key | Quotes, logos, universe, news, corporate actions |
| Finnhub API key | Earnings / recommendations / insider (Lambda only) |
| xAI API key (optional) | News/Rumors Grok summaries |
| Telegram bot (@BotFather) | Token + `@<telegram-bot-username>` |

## 2. Local env file

```bash
cp env.example .env.local
# Replace every <placeholder>
```

Required for first infra deploy (see `aws/sam-params.sh`):

- `ADMIN_EMAILS=<admin-email>`
- `PRODUCTION_SITE_URL=https://<your-domain>`

Optional injectables (defaults keep this repo’s production paths if unset):

| `.env.local` | SAM parameter | Default |
| --- | --- | --- |
| `SES_IDENTITY_DOMAIN` | `SesIdentityDomain` | `stocktextalerts.com` |
| `SSM_PREFIX` | `SsmPrefix` | `/stocktextalerts` |
| `ALERT_TOPIC_SSM_PARAM` | `AlertTopicArn` | `/shared-infra/alert-topic-arn` |
| `EMAIL_FROM_SSM_PARAM` | `EmailFrom` | `<ssm-prefix>/email-from` |
| `BACKUP_CONNECTION_SSM_PARAM` | `BackupConnectionSsmParam` | `<ssm-prefix>/backup/connection-string` |

Forks: set these instead of editing [`aws/template.yaml`](../aws/template.yaml).

## 3. AWS prerequisites (before first `deploy:infra`)

1. Copy [`aws/samconfig.toml.example`](../aws/samconfig.toml.example) → `aws/samconfig.toml` (gitignored).
2. Verify an SES identity for `<ses-verified-domain>` (must match `SES_IDENTITY_DOMAIN`). Leave the SES sandbox if you will email arbitrary users.
3. Create an SNS topic for CloudWatch alarms (or reuse one). Put its ARN in an SSM **String** parameter named by `ALERT_TOPIC_SSM_PARAM`.
4. Create SSM **String** `EMAIL_FROM_SSM_PARAM` with value like `StockTextAlerts <notifications@updates.<your-domain>>`.
5. Create SSM **SecureString** parameters under `<ssm-prefix>/` (see table below), then provision a GitHub OIDC deploy role that can `lambda:UpdateFunctionCode` (and invoke the live-provider-check function). Point GitHub env var `AWS_DEPLOY_ROLE_ARN` at it.

```bash
# Pattern (repeat per secret):
aws ssm put-parameter --type SecureString --key-id alias/aws/ssm --overwrite \
  --name <ssm-prefix>/<kebab-name> --value <secret>
```

| Path under `<ssm-prefix>/` | Secret |
| --- | --- |
| `massive-api-key` | Massive |
| `finnhub-api-key` | Finnhub |
| `xai-api-key` | Optional (omit or leave unset — handlers degrade) |
| `telegram-bot-token` | Telegram bot token |
| `supabase-url` | Hosted Supabase URL |
| `supabase-secret-key` | Service role key |
| `unsubscribe-token-secret` | Same value as Vercel `UNSUBSCRIBE_TOKEN_SECRET` |
| `email-dispatch-secret` | Same value as Vercel `EMAIL_DISPATCH_SECRET` |
| `backup/connection-string` | Read-only Postgres URL for the backup Lambda |

## 4. First infra deploy

```bash
npm run deploy:infra
```

Requires admin AWS credentials (not the scoped code-only role). Creates Lambdas, schedules, alarms, SQS, and the email-dispatch Function URL.

Then set Vercel `EMAIL_DISPATCH_URL=<email-dispatch-function-url>` from the stack output.

## 5. Supabase (hosted)

1. Create the project; note URL, publishable key, and service-role key.
2. Auth → URL configuration: Site URL `https://<your-domain>`; redirect URLs including `https://<your-domain>/auth/verified`.
3. Paste HTML from `supabase/templates/*.html` into the Dashboard auth email templates (local `config.toml` does **not** apply to hosted Auth).
4. First schema apply happens via the GitHub deploy workflow’s `supabase db push` (needs `DATABASE_URL_PROD` in the GitHub `Production` environment). Do not run ad-hoc production `db push` from a laptop as the normal path.

## 6. Vercel environment

Set for Production (and Preview as needed). Do **not** mirror all of `.env.local`.

| Variable | Notes |
| --- | --- |
| `SUPABASE_URL` / `SUPABASE_PUBLISHABLE_KEY` / `SUPABASE_SECRET_KEY` | Or use the Vercel↔Supabase integration |
| `UNSUBSCRIBE_TOKEN_SECRET` | Must match SSM |
| `MASSIVE_API_KEY` | Logo proxy |
| `ADMIN_EMAILS` | Pending-user approval allowlist |
| `EMAIL_DISPATCH_URL` / `EMAIL_DISPATCH_SECRET` | After infra deploy |
| `TELEGRAM_BOT_TOKEN` | Webhook replies |
| `TELEGRAM_BOT_USERNAME` | Deep-link UI |
| `TELEGRAM_WEBHOOK_SECRET` | Header check on `/api/messaging/telegram` |
| `TELEGRAM_LINK_TOKEN_SECRET` | Link-token HMAC |

Omit on Vercel: `FINNHUB_API_KEY`, `XAI_API_KEY`, `EMAIL_FROM`, `DATABASE_URL`, `DEFAULT_PASSWORD`, static AWS keys.

## 7. Telegram (manual scripts)

```bash
npm run telegram:set-commands   # needs TELEGRAM_BOT_TOKEN
npm run telegram:set-webhook    # token + TELEGRAM_WEBHOOK_SECRET + production HTTPS URL
```

Webhook URL defaults to `https://<your-domain>/api/messaging/telegram` (or set `TELEGRAM_WEBHOOK_URL`). Localhost is rejected by Telegram.

Confirm with a real human `/start` in the bot chat.

## 8. GitHub Actions `Production` environment

| Kind | Name |
| --- | --- |
| Secret | `DATABASE_URL_PROD` |
| Variable | `AWS_REGION` |
| Variable | `AWS_DEPLOY_ROLE_ARN` |
| Variable | `PRODUCTION_SITE_URL` |

Use OIDC assume-role — no long-lived AWS keys in GitHub.

Suggested branch protection: require a PR + the `CI / ci` check (non-strict is fine if you accept post-merge canary CI). See [github-ci.md](github-ci.md) for how *this* repository wires auto-merge and runners.

## 9. Ongoing releases

| Change type | What to do |
| --- | --- |
| App / migration / Lambda code | Merge to `main` → Vercel Git + `deploy.yml` |
| `aws/template.yaml` or `aws/deploy.sh` | Merge, then manual `npm run deploy:infra` again |
| Rotate Telegram token / webhook secret | Update SSM + Vercel, then `telegram:set-webhook -- --force` |

`npm run deploy:code` is a local break-glass path only.

## Env matrix

| Variable | Local | Vercel | Lambda (SSM / SAM) | GitHub Production |
| --- | --- | --- | --- | --- |
| `VERCEL_URL` | yes | auto | — | — |
| `PRODUCTION_SITE_URL` | yes (infra) | — | → `SiteUrl` | **var** |
| `SUPABASE_*` | local stack | prod | SSM URL + secret key | — |
| `DATABASE_URL` | local only | no | — | — |
| `DATABASE_URL_PROD` | break-glass | no | — | **secret** |
| `UNSUBSCRIBE_TOKEN_SECRET` | yes | yes | SSM | — |
| `EMAIL_FROM` | local/Mailpit | no | SSM via `EmailFrom` | — |
| `ADMIN_EMAILS` | yes | yes | SAM plain env | — |
| `EMAIL_DISPATCH_*` | optional | yes | secret in SSM | — |
| `MASSIVE_API_KEY` | yes | yes | SSM | — |
| `FINNHUB_API_KEY` | stub/tests | no | SSM | — |
| `XAI_API_KEY` | optional | no | SSM optional | — |
| `TELEGRAM_BOT_TOKEN` | scripts | yes | SSM | — |
| `TELEGRAM_BOT_USERNAME` | yes | yes | — | — |
| `TELEGRAM_WEBHOOK_SECRET` | scripts | yes | — | — |
| `TELEGRAM_LINK_TOKEN_SECRET` | yes | yes | — | — |
| `DEFAULT_PASSWORD` | seed only | no | — | — |
| `SES_IDENTITY_DOMAIN` / `SSM_PREFIX` / `ALERT_TOPIC_SSM_PARAM` | infra only | — | SAM params | — |

## Fork notes

- **Injectables above** relocate SES identity and SSM namespaces without editing the template. Defaults preserve this project’s production values when unset.
- **Lambda `FunctionName`s** (`stocktextalerts-*`) and the CloudFormation stack name are still fixed in the template — change those only if you need a second stack in the same account (manual YAML edit; existing stacks would replace resources).
- **CI runners:** this repo uses Blacksmith labels and an optional janitor workflow. Forks without Blacksmith should switch workflow `runs-on` to `ubuntu-latest` (and drop sticky-disk steps). Janitor secrets are optional and not required to run the app.
- **Alert topic:** point `ALERT_TOPIC_SSM_PARAM` at any SNS topic ARN stored in SSM; you do not need a sibling “shared-infra” repo.
- **SMS / Twilio:** not part of the current product. Removed in [#550](https://github.com/birthmilk/stocktextalerts/pull/550) (app + schema) and [#551](https://github.com/birthmilk/stocktextalerts/pull/551) (Twilio SSM env vars). See the README “Historical note: SMS removed” for how to start if you want that channel back.
