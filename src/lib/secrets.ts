import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";

// Fetch secrets at runtime so they never live in a plaintext Lambda env var.
// `lambda:GetFunctionConfiguration` returns env vars in the clear regardless of
// a SAM param's NoEcho flag, so a "read-only" IAM role that can call it can read
// every secret. Instead, prod sets `<NAME>_SSM_PARAM` to an SSM SecureString
// param name and we fetch+decrypt it at runtime, putting the secret behind
// `ssm:GetParameter`.
//
// An explicit `<NAME>` env var always wins, so the Vercel web runtime and the
// local/test suites — which set the real env vars — never touch SSM and stay
// offline. This env-fallback is what lets the SAME shared lib code (read via
// the dozens of synchronous `requireEnv()` call sites) run unchanged in both the
// Lambda and web runtimes.
//
// Design: shared-infra docs/specs/2026-06-22-secret-runtime-fetch-design.md.

/**
 * Every secret StockTextAlerts' Lambdas may read. The shared `runLambda` wrapper
 * prefetches this whole list via `loadSecretsIntoEnv` before any handler body
 * runs; only the names whose `<NAME>_SSM_PARAM` is set on that function (the
 * template's per-function env block — the least-privilege control) actually hit
 * SSM. The rest are skipped, so requesting all of them everywhere can't "miss" a
 * secret a handler's import tree reads.
 */
export const STOCKTEXTALERTS_SECRET_NAMES = [
	"SUPABASE_URL",
	"SUPABASE_SECRET_KEY",
	"MASSIVE_API_KEY",
	"FINNHUB_API_KEY",
	"XAI_API_KEY",
	"EMAIL_DISPATCH_SECRET",
	"UNSUBSCRIBE_TOKEN_SECRET",
	"TELEGRAM_BOT_TOKEN",
	"TWILIO_ACCOUNT_SID",
	"TWILIO_API_KEY_SID",
	"TWILIO_API_KEY_SECRET",
	"TWILIO_PHONE_NUMBER",
] as const;

// Secrets whose feature degrades gracefully when absent, so a NOT-provisioned SSM
// param must NOT hard-fail the handler. XAI_API_KEY drives the optional Grok
// summary: every consumer reads it with `readEnv` and skips the AI call when it's
// missing (grok-summary.ts, grok.ts). It was also optional under the old SAM
// wiring (`XaiApiKey=${XAI_API_KEY:-}`). So for these, a ParameterNotFound is
// swallowed (left unset → readEnv degrades); any other error still fails loud.
const OPTIONAL_SECRET_NAMES = new Set<string>(["XAI_API_KEY"]);

const cache = new Map<string, string>();
let ssmClient: SSMClient | undefined;

/**
 * Resolve a logical secret NAME: an explicit `process.env[NAME]` wins (local /
 * test / Vercel), otherwise fetch+decrypt the SSM SecureString named by
 * `process.env[`${NAME}_SSM_PARAM`]`. Successful fetches are cached per-name;
 * failures are never cached so a transient SSM error is retried on the next call.
 */
export async function getSecret(name: string): Promise<string> {
	const fromEnv = process.env[name];
	if (fromEnv) {
		return fromEnv;
	}

	const cached = cache.get(name);
	if (cached) {
		return cached;
	}

	const paramName = process.env[`${name}_SSM_PARAM`];
	if (!paramName) {
		throw new Error(`${name} not configured: set ${name} (local) or ${name}_SSM_PARAM (Lambda)`);
	}

	ssmClient ??= new SSMClient({});
	const { Parameter } = await ssmClient.send(
		new GetParameterCommand({ Name: paramName, WithDecryption: true }),
	);
	const value = Parameter?.Value;
	if (!value) {
		throw new Error(`SSM parameter ${paramName} (for ${name}) has no value`);
	}

	cache.set(name, value);
	return value;
}

/**
 * Prefetch the given secrets into `process.env` in one parallel batch, so the
 * scattered synchronous `requireEnv()` reads across the shared lib see them.
 * Call this as the FIRST line of every Lambda handler, before any import-tree
 * code reads an env var.
 *
 * A name is skipped (left as-is) when it's already set in `process.env` or has no
 * `<NAME>_SSM_PARAM` configured — so on Vercel/local this is a no-op, and a
 * function only fetches the subset its template actually wires up. An SSM fetch
 * failure rejects loudly at cold start rather than surfacing later as a confusing
 * `requireEnv` error.
 */
export async function loadSecretsIntoEnv(names: readonly string[]): Promise<void> {
	await Promise.all(
		names.map(async (name) => {
			if (process.env[name]) {
				return;
			}
			if (!process.env[`${name}_SSM_PARAM`]) {
				return;
			}
			try {
				process.env[name] = await getSecret(name);
			} catch (err) {
				// An optional secret whose SSM param was never provisioned is fine:
				// leave it unset so the feature's `readEnv` path degrades. Any other
				// failure (AccessDenied, transient SSM, a required secret) fails loud.
				if (
					OPTIONAL_SECRET_NAMES.has(name) &&
					err instanceof Error &&
					err.name === "ParameterNotFound"
				) {
					return;
				}
				throw err;
			}
		}),
	);
}
