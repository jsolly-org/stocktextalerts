#!/usr/bin/env tsx
/**
 * scripts/check-infra-drift.ts — post-deploy guard that the DEPLOYED Lambda
 * configuration (Timeout, MemorySize) matches aws/template.yaml.
 *
 * Why this exists: template.yaml is infra, applied only by a manual, human-MFA
 * `npm run deploy:infra` — while code ships automatically on every merge. A PR
 * that changes both leaves prod running new code against old function config
 * until a human remembers the infra half. That exact drift caused the 2026-07-07
 * incident: PR #549 shipped a call budget sized for a 900s timeout, the committed
 * `Timeout: 900` never got applied, and the function timed out nightly at the
 * deployed 300s. Nothing detected the gap. This check runs in the GitHub deploy
 * workflow after every code deploy and fails RED, with a "run deploy:infra"
 * message, when the deployed config drifts from the committed template.
 *
 * Template parsing lives in scripts/sam-template.ts, shared with
 * check-deploy-functions.ts so the two guards provably agree on what a
 * "function" is.
 *
 * Fails CLOSED: zero functions parsed, a function without a literal FunctionName,
 * a function with no resolvable Timeout, or an `aws lambda
 * get-function-configuration` failure are all errors — a green "checked nothing"
 * is worse than a red check.
 *
 * Scope: config drift only. Code-version drift is impossible on this path (the
 * workflow just pushed the code), and full-template drift (env vars, alarms,
 * schedules) still belongs to CloudFormation itself.
 *
 * Usage: npm run check:infra-drift   (deploy.yml, after "Deploy migrations and Lambdas")
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { rootLogger } from "../src/lib/logging";
import { parseSamTemplate } from "./sam-template";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");
const TEMPLATE_PATH = path.join(projectRoot, "aws", "template.yaml");

const ACTION = "check_infra_drift";

function getDeployedConfig(functionName: string): { timeout: number; memorySize: number } {
	const raw = execFileSync(
		"aws",
		[
			"lambda",
			"get-function-configuration",
			"--function-name",
			functionName,
			"--query",
			"{Timeout: Timeout, MemorySize: MemorySize}",
			"--output",
			"json",
		],
		{ encoding: "utf8" },
	);
	const parsed: unknown = JSON.parse(raw);
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		typeof (parsed as Record<string, unknown>).Timeout !== "number" ||
		typeof (parsed as Record<string, unknown>).MemorySize !== "number"
	) {
		throw new Error(`Unexpected get-function-configuration payload for ${functionName}: ${raw}`);
	}
	const record = parsed as { Timeout: number; MemorySize: number };
	return { timeout: record.Timeout, memorySize: record.MemorySize };
}

function main(): void {
	// One clear failure when the aws CLI is absent, instead of 7 per-function ENOENTs.
	try {
		execFileSync("aws", ["--version"], { encoding: "utf8" });
	} catch {
		rootLogger.error("Infra drift check failed", { action: ACTION }, new Error("aws CLI not found"));
		process.exit(1);
	}

	const template = fs.readFileSync(TEMPLATE_PATH, "utf8");
	const { globals, functions } = parseSamTemplate(template);

	const problems: string[] = [];
	if (functions.length === 0) {
		problems.push("Parsed zero AWS::Serverless::Function resources from aws/template.yaml.");
	}

	const drifts: string[] = [];
	for (const fn of functions) {
		if (!fn.functionName) {
			problems.push(`${fn.logicalId}: no literal FunctionName — cannot verify deployed config.`);
			continue;
		}
		const expectedTimeout = fn.timeout ?? globals.timeout;
		const expectedMemory = fn.memorySize ?? globals.memorySize;
		if (expectedTimeout === null || expectedMemory === null) {
			problems.push(
				`${fn.functionName}: could not resolve expected Timeout/MemorySize from the template (function or Globals).`,
			);
			continue;
		}

		let deployed: { timeout: number; memorySize: number };
		try {
			deployed = getDeployedConfig(fn.functionName);
		} catch (error) {
			problems.push(
				`${fn.functionName}: get-function-configuration failed (${error instanceof Error ? error.message : String(error)}).`,
			);
			continue;
		}

		if (deployed.timeout !== expectedTimeout) {
			drifts.push(
				`${fn.functionName}: Timeout deployed=${deployed.timeout}s template=${expectedTimeout}s`,
			);
		}
		if (deployed.memorySize !== expectedMemory) {
			drifts.push(
				`${fn.functionName}: MemorySize deployed=${deployed.memorySize}MB template=${expectedMemory}MB`,
			);
		}
	}

	if (problems.length > 0 || drifts.length > 0) {
		rootLogger.error(
			"Infra drift check failed",
			{ action: ACTION, problems, drifts },
			new Error(
				[
					...problems,
					...drifts,
					drifts.length > 0
						? "Deployed Lambda config drifts from aws/template.yaml — run `npm run deploy:infra` manually (human MFA) to apply the committed template."
						: "",
				]
					.filter(Boolean)
					.join(" | "),
			),
		);
		process.exit(1);
	}

	rootLogger.info("Infra drift check passed", {
		action: ACTION,
		functionsChecked: functions.length,
	});
}

main();
