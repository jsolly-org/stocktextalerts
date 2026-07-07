#!/usr/bin/env tsx
/**
 * scripts/check-deploy-functions.ts — static guard that the Phase 2 `deploy_code`
 * list in aws/deploy-web.sh covers EXACTLY the set of `AWS::Serverless::Function`
 * resources in aws/template.yaml (matching both logical ID and physical
 * FunctionName).
 *
 * Why this exists: the push-time deploy ships Lambda *code only* by looping
 * `deploy_code <LogicalId> <physical-name>` over a hand-maintained list. ALL
 * functions share src/lib, so if the list omits a function, that function keeps
 * running stale code against the freshly migrated schema until the next full
 * `npm run deploy:infra` — the duplicate-SMS incident class. This actually bit on
 * 2026-06-21 (the Telegram ship): live-provider-check and backup-user-settings
 * were defined in the template but missing from the deploy list, so they only
 * picked up new code via the manual SAM deploy. The "keep this list in sync"
 * comment above the list is not self-enforcing; this check enforces it.
 *
 * Template parsing lives in scripts/sam-template.ts (shared with
 * check-infra-drift.ts): intentionally line/regex based, not a YAML parse — see
 * that file's header. This guard consumes the {logicalId, functionName} subset.
 *
 * Fails CLOSED in three ways, so the guard can't silently approve a stale deploy:
 *   1. Either file parses to zero entries → error (a green "found nothing" is
 *      worse than a red one).
 *   2. A resource IS an `AWS::Serverless::Function` but has no literal
 *      `FunctionName: stocktextalerts-*` the guard can verify (a `!Sub`/`!Ref`
 *      name, or none — SAM would auto-generate one) → error. `deploy_code`
 *      targets functions by a literal physical name, so an unverifiable function
 *      can't be covered by the list at all; flag it loudly instead of dropping
 *      it from the comparison (which would let it ship stale code unnoticed).
 *   3. The verifiable set drifts from the deploy list → error.
 *
 * Exit codes: 0 — list matches the template. 1 — drift, an unverifiable
 * function, or a parse that found nothing.
 *
 * Usage: npm run check:deploy-functions   (also runs in the pre-push gate)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { rootLogger } from "../src/lib/logging";
import { parseSamTemplate } from "./sam-template";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");
const TEMPLATE_PATH = path.join(projectRoot, "aws", "template.yaml");
const DEPLOY_SCRIPT_PATH = path.join(projectRoot, "aws", "deploy-web.sh");

const ACTION = "check_deploy_functions";

/**
 * Extract the `deploy_code <LogicalId> <physical-name>` call lines from the
 * deploy script. The function *definition* line (`deploy_code() { ... }`) has no
 * whitespace after `deploy_code`, so the leading `\s+` excludes it. The anchor is
 * column-0 and rejects a trailing comment — a deploy_code call that is indented
 * or carries a `# comment` is dropped; that direction is SAFE (a dropped real
 * call surfaces as a "missing from deploy list" failure, never a silent pass).
 */
function parseDeployList(text: string): Map<string, string> {
	const out = new Map<string, string>();
	const CALL_RE = /^deploy_code\s+([A-Za-z][A-Za-z0-9]*)\s+(\S+)\s*$/;
	const seen = new Set<string>();
	const duplicates: string[] = [];
	for (const line of text.split("\n")) {
		const m = CALL_RE.exec(line);
		if (!m?.[1] || !m[2]) continue;
		if (seen.has(m[1])) duplicates.push(m[1]);
		seen.add(m[1]);
		out.set(m[1], m[2]);
	}
	if (duplicates.length > 0) {
		throw new Error(`duplicate deploy_code entries for: ${duplicates.join(", ")}`);
	}
	return out;
}

function main(): void {
	for (const p of [TEMPLATE_PATH, DEPLOY_SCRIPT_PATH]) {
		if (!fs.existsSync(p)) {
			rootLogger.error("check:deploy-functions — file not found", { action: ACTION, path: p });
			process.exitCode = 1;
			return;
		}
	}

	const templateFunctions = parseSamTemplate(fs.readFileSync(TEMPLATE_PATH, "utf-8")).functions;
	const deployFns = parseDeployList(fs.readFileSync(DEPLOY_SCRIPT_PATH, "utf-8"));

	// Fail closed: a parse that found nothing must not vacuously pass.
	if (templateFunctions.length === 0) {
		rootLogger.error("check:deploy-functions — parsed zero functions from the template", {
			action: ACTION,
			template: TEMPLATE_PATH,
		});
		process.exitCode = 1;
		return;
	}
	if (deployFns.size === 0) {
		rootLogger.error("check:deploy-functions — parsed zero deploy_code entries", {
			action: ACTION,
			deployScript: DEPLOY_SCRIPT_PATH,
		});
		process.exitCode = 1;
		return;
	}

	const errors: string[] = [];

	// All function logical IDs (verifiable or not) — used so an unverifiable
	// function that IS in the deploy list isn't double-flagged as a stale entry.
	const allFunctionIds = new Set(templateFunctions.map((f) => f.logicalId));
	// The verifiable subset: functions with a literal stocktextalerts-* name that
	// `deploy_code` can actually target.
	const templateFns = new Map<string, string>();
	for (const f of templateFunctions) {
		if (f.functionName) templateFns.set(f.logicalId, f.functionName);
	}

	// A Serverless::Function with no literal FunctionName the guard can verify —
	// deploy_code can't target it by a stable physical name, so it would ship
	// stale on every push. Fail loud rather than silently exclude it.
	for (const f of templateFunctions) {
		if (f.functionName === null) {
			errors.push(
				`${f.logicalId} is an AWS::Serverless::Function in aws/template.yaml with no literal ` +
					`'FunctionName: stocktextalerts-*' this guard can verify (a !Sub/!Ref name, or none — ` +
					`SAM would auto-generate one). The push-time deploy_code list targets functions by ` +
					`literal physical name, so give it an explicit FunctionName or it ships stale code.`,
			);
		}
	}

	// In the template but never deployed — the stale-code bug.
	for (const [logicalId, fnName] of templateFns) {
		if (!deployFns.has(logicalId)) {
			errors.push(
				`${logicalId} (${fnName}) is an AWS::Serverless::Function in aws/template.yaml ` +
					`but has no \`deploy_code\` line in aws/deploy-web.sh — its code would run stale ` +
					`against a freshly migrated schema. Add: deploy_code ${logicalId} ${fnName}`,
			);
		}
	}

	// In the deploy list but not a function in the template — a stale/renamed entry.
	for (const [logicalId, fnName] of deployFns) {
		if (!allFunctionIds.has(logicalId)) {
			errors.push(
				`deploy_code ${logicalId} ${fnName} in aws/deploy-web.sh has no matching ` +
					`AWS::Serverless::Function '${logicalId}' in aws/template.yaml — remove or rename it.`,
			);
		}
	}

	// Logical ID present in both but the physical FunctionName disagrees.
	for (const [logicalId, deployName] of deployFns) {
		const templateName = templateFns.get(logicalId);
		if (templateName && templateName !== deployName) {
			errors.push(
				`${logicalId}: deploy-web.sh deploys '${deployName}' but template.yaml names it ` +
					`'${templateName}' — the update-function-code call would target the wrong function.`,
			);
		}
	}

	if (errors.length > 0) {
		rootLogger.error("check:deploy-functions — deploy list drifted from the template", {
			action: ACTION,
			errorCount: errors.length,
			errors,
			templateFunctions: templateFunctions.map((f) => f.logicalId).sort(),
			deployedFunctions: [...deployFns.keys()].sort(),
		});
		process.exitCode = 1;
		return;
	}

	rootLogger.info("check:deploy-functions — ok", {
		action: ACTION,
		functionCount: templateFns.size,
	});
}

try {
	main();
} catch (err) {
	rootLogger.error(
		"check:deploy-functions — unexpected error",
		{ action: ACTION },
		err instanceof Error ? err : new Error(String(err)),
	);
	process.exitCode = 1;
}
