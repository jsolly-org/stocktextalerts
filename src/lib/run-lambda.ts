import type { Context } from "aws-lambda";
import { runWithRequestContext } from "./logging/request-context";
import { loadSecretsIntoEnv, STOCKTEXTALERTS_SECRET_NAMES } from "./secrets";

/**
 * Shared entry wrapper for every StockTextAlerts Lambda handler.
 *
 * Owns the two cross-cutting bootstrap concerns in the one order they must run:
 *   1. hydrate runtime secrets from SSM into process.env, BEFORE any business
 *      logic or import-tree code reads them via requireEnv (see src/lib/secrets.ts);
 *   2. enter the request-id logging context (see request-context.ts).
 *
 * Handlers call `runLambda(context, async () => { ... })` instead of repeating
 * this preamble, so the secrets-before-context ordering invariant lives in exactly
 * one place and a newly-added handler can't silently forget it. Import only in
 * Lambda handlers — never in browser bundles.
 */
export function runLambda<T>(context: Context, fn: () => Promise<T>): Promise<T> {
	return loadSecretsIntoEnv(STOCKTEXTALERTS_SECRET_NAMES).then(() =>
		runWithRequestContext(context.awsRequestId, fn),
	);
}
