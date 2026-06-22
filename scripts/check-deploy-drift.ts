#!/usr/bin/env tsx
/**
 * scripts/check-deploy-drift.ts — read-only audit that every live Lambda is
 * running code at origin/main, not a stale deploy.
 *
 * Why this exists (complements check-deploy-functions.ts): that guard proves the
 * push-time deploy *list* covers every template function. This one proves the
 * deploy actually *fired* and *landed*. Two 2026-06-21/22 incidents motivated it:
 *   1. A deploy applied the Supabase migration (Phase 2) but aborted on a bundle
 *      build break before Phase 3 updated the schedule Lambda — migrated schema +
 *      stale code → an outage.
 *   2. origin/main advanced via a merge that never triggered the push-time deploy
 *      at all — the change sat undeployed with no signal.
 * Neither is catchable by the pre-push gate (the gate runs *during* a push; the
 * failure is a push whose deploy didn't run). This is the standing detector for it.
 *
 * WHICH SIGNAL = the deployed code version. There are TWO provenance fields and
 * they DIVERGE — getting this wrong makes the audit lie:
 *   - `release` (RELEASE_ID, src/lib/logging/release-id.ts) is baked into the
 *     bundle at BUILD time, so it updates on every `update-function-code` (the
 *     push-time, code-only deploy). THIS is the running code version.
 *   - the `GIT_SHA` env var is set only by a full SAM deploy (aws/sam-params.sh);
 *     `aws lambda update-function-code` does NOT touch env vars. So GIT_SHA goes
 *     stale the moment any code-only deploy lands — it tracks the last *infra*
 *     deploy, not the code. Reading it (an earlier version of this script did)
 *     reports false drift on a perfectly-current fleet.
 * So we read the most recent `release` from each function's CloudWatch logs.
 *
 * Fails CLOSED:
 *   - aws CLI absent, fetch fails, or list returns zero functions → exit 1 (a
 *     green "found nothing" is the worst outcome for a drift check).
 *   - any function whose live `release` is unknown to git history (diverged /
 *     force-push), or behind origin/main with src/ changes → exit 1.
 * Reported but NOT failed: tooling/docs-only drift (no src/ in the gap), and
 * functions with no recent logs to read a release from (unverifiable, not stale).
 *
 * Read-only: lambda:ListFunctions + logs:FilterLogEvents + local git. No mutation.
 * Usage: npm run check:deploy-drift   (manual; needs AWS read creds)
 */
import { execFileSync } from "node:child_process";

const FUNCTION_PREFIX = "stocktextalerts-";
// Windows to look back for a `release` log line, widening for infrequently-invoked
// (cron) functions before giving up and calling a function unverifiable.
const LOG_LOOKBACK_SECONDS = [6 * 3600, 72 * 3600];
const RELEASE_RE = /"release":"([0-9a-fA-F]+|dev)"/;

function sh(cmd: string, args: string[]): string {
	return execFileSync(cmd, args, { encoding: "utf8" }).trim();
}

function gitOk(args: string[]): boolean {
	try {
		execFileSync("git", args, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/** Most recent {release, timestamp} from a function's logs, or null if none. */
function latestRelease(fnName: string): { rel: string; ts: number } | null {
	for (const lookback of LOG_LOOKBACK_SECONDS) {
		const startMs = (Date.now() - lookback * 1000).toString();
		let raw: string;
		try {
			raw = sh("aws", [
				"logs",
				"filter-log-events",
				"--log-group-name",
				`/aws/lambda/${fnName}`,
				"--start-time",
				startMs,
				"--filter-pattern",
				'"release"',
				"--query",
				"events[].{t:timestamp, m:message}",
				"--output",
				"json",
			]);
		} catch {
			return null; // no log group / no read access
		}
		const events = JSON.parse(raw) as { t: number; m: string }[];
		let best: { t: number; rel: string } | null = null;
		for (const e of events) {
			const rel = e.m.match(RELEASE_RE)?.[1];
			if (rel && (!best || e.t > best.t)) best = { t: e.t, rel };
		}
		if (best) return { rel: best.rel, ts: best.t };
	}
	return null;
}

function main(): void {
	// Presence-guard the system CLI (dependency-grounding: fail loud, don't assume PATH).
	try {
		sh("aws", ["--version"]);
	} catch {
		console.error("✗ aws CLI not found — install it (and authenticate) to audit deploy drift.");
		process.exit(1);
	}

	// Compare against the *fetched* remote tip — fail loud if the fetch fails, or the
	// audit would silently validate against a stale local origin/main and report a
	// genuinely-behind fleet as current (the exact false-green this detector prevents).
	if (!gitOk(["fetch", "origin", "main", "--quiet"])) {
		console.error(
			"✗ git fetch origin main failed — refusing to audit against an unverified (possibly stale) origin/main.",
		);
		process.exit(1);
	}
	const target = sh("git", ["rev-parse", "origin/main"]);
	const targetShort = target.slice(0, 8);

	// LastModified = when code was last deployed (update-function-code bumps it). We
	// compare it against the latest log timestamp to tell "running stale code" from
	// "freshly deployed, not yet re-invoked" (a cron function whose last log predates
	// the deploy) — the latter is NOT drift, just log-lag.
	const raw = sh("aws", [
		"lambda",
		"list-functions",
		"--query",
		`Functions[?starts_with(FunctionName, '${FUNCTION_PREFIX}')].{name:FunctionName, modified:LastModified}`,
		"--output",
		"json",
	]);
	const fns = (JSON.parse(raw) as { name: string; modified: string }[]).sort((a, b) =>
		a.name.localeCompare(b.name),
	);

	if (fns.length === 0) {
		console.error(
			`✗ no ${FUNCTION_PREFIX}* functions found — wrong account/region, or a broken read. Refusing to report "no drift".`,
		);
		process.exit(1);
	}

	console.log(`Deploy-drift audit — target origin/main = ${targetShort}\n`);

	const problems: string[] = [];
	const pending: string[] = [];
	const unverifiable: string[] = [];
	for (const { name, modified } of fns) {
		const deployedAt = Date.parse(modified);
		const latest = latestRelease(name);
		if (!latest || latest.rel === "dev") {
			console.log(`  ? ${name}: no recent 'release' log line — cannot verify deployed version`);
			unverifiable.push(name);
			continue;
		}
		const { rel: release, ts: logTs } = latest;
		// Code redeployed AFTER the function last ran → the log release is the OLD
		// code; the deployed code is presumed current and confirms on next invocation.
		if (Number.isFinite(deployedAt) && logTs < deployedAt) {
			console.log(`  ⟳ ${name}: redeployed after last run — current pending next invocation (last ran ${release})`);
			pending.push(name);
			continue;
		}
		// Resolve the 12-char RELEASE_ID to a real commit. Unknown = diverged / force-push.
		if (!gitOk(["rev-parse", "--verify", "--quiet", `${release}^{commit}`])) {
			console.log(`  ✗ ${name}: release ${release} unknown to git history (diverged / force-push)`);
			problems.push(name);
			continue;
		}
		const releaseFull = sh("git", ["rev-parse", `${release}^{commit}`]);
		if (releaseFull === target) {
			console.log(`  ✓ ${name}: ${release} (current)`);
			continue;
		}
		if (!gitOk(["merge-base", "--is-ancestor", release, target])) {
			console.log(`  ✗ ${name}: release ${release} is NOT an ancestor of origin/main (diverged)`);
			problems.push(name);
			continue;
		}
		// Behind AND has run on this code since the deploy: genuine drift. Does the gap touch src/?
		const srcChanges = sh("git", ["diff", "--name-only", `${release}..${target}`, "--", "src/"]);
		if (srcChanges) {
			const files = srcChanges.split("\n").filter(Boolean);
			console.log(
				`  ✗ ${name}: ${release} → ${targetShort} STALE — ${files.length} runtime file(s) undeployed:`,
			);
			for (const f of files.slice(0, 10)) console.log(`        ${f}`);
			if (files.length > 10) console.log(`        … and ${files.length - 10} more`);
			problems.push(name);
		} else {
			console.log(
				`  ~ ${name}: ${release} → ${targetShort} behind, but no src/ changes (tooling/docs only)`,
			);
		}
	}

	if (pending.length > 0) {
		console.log(`\n⟳ ${pending.length} freshly deployed, awaiting next invocation: ${pending.join(", ")}`);
	}
	if (unverifiable.length > 0) {
		console.log(
			`\n? ${unverifiable.length} function(s) unverifiable (no recent logs): ${unverifiable.join(", ")}`,
		);
	}
	if (problems.length > 0) {
		console.error(
			`\n✗ ${problems.length} function(s) running stale runtime code: ${problems.join(", ")}`,
		);
		console.error("  Redeploy from a credentialed laptop: git push origin HEAD:main, or npm run deploy.");
		process.exit(1);
	}
	console.log("\n✓ all verifiable functions current (or behind only on tooling/docs).");
}

main();
