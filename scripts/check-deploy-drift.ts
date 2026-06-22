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
 *   2. origin/main advanced 8 commits (incl. the Telegram undici fix) via a merge
 *      that never triggered the push-time deploy at all — the fix sat undeployed.
 * Neither is catchable by the pre-push gate (the gate runs *during* a push; the
 * failure is a push whose deploy didn't run). This is the standing detector for it.
 *
 * The fleet stamps GIT_SHA on every deployed Lambda. For each stocktextalerts-*
 * function this compares the live GIT_SHA against origin/main and, when behind,
 * diffs the gap to judge whether *runtime* code (src/) drifted vs only tooling/docs.
 *
 * Fails CLOSED:
 *   - aws CLI absent, or list returns zero functions → error (a green "found
 *     nothing" is the worst outcome for a drift check).
 *   - any function whose live GIT_SHA is missing, unknown to git history
 *     (diverged / force-push / never-stamped), or behind with src/ changes → exit 1.
 * Tooling/docs-only drift (no src/ in the gap) is reported as OK-but-behind, exit 0.
 *
 * Read-only: lambda:ListFunctions + local git. No deploy, no mutation.
 * Usage: npm run check:deploy-drift   (manual; needs AWS read creds + origin fetched)
 */
import { execFileSync } from "node:child_process";

const FUNCTION_PREFIX = "stocktextalerts-";

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

	// One ListFunctions call returns full configs incl. Environment.Variables.
	const raw = sh("aws", [
		"lambda",
		"list-functions",
		"--query",
		`Functions[?starts_with(FunctionName, '${FUNCTION_PREFIX}')].{name:FunctionName, sha:Environment.Variables.GIT_SHA}`,
		"--output",
		"json",
	]);
	const fns = JSON.parse(raw) as { name: string; sha: string | null }[];

	if (fns.length === 0) {
		console.error(
			`✗ no ${FUNCTION_PREFIX}* functions found — wrong account/region, or a broken read. Refusing to report "no drift".`,
		);
		process.exit(1);
	}

	console.log(`Deploy-drift audit — target origin/main = ${targetShort}\n`);

	const problems: string[] = [];
	for (const { name, sha } of fns.sort((a, b) => a.name.localeCompare(b.name))) {
		if (!sha) {
			console.log(`  ✗ ${name}: no GIT_SHA stamped (pre-provenance or failed deploy)`);
			problems.push(name);
			continue;
		}
		if (sha === targetShort || sha === target) {
			console.log(`  ✓ ${name}: ${sha} (current)`);
			continue;
		}
		// Behind, diverged, or unknown? An unknown/diverged sha is a hard flag.
		if (!gitOk(["cat-file", "-e", `${sha}^{commit}`])) {
			console.log(`  ✗ ${name}: ${sha} unknown to git history (diverged / force-push / unstamped)`);
			problems.push(name);
			continue;
		}
		if (!gitOk(["merge-base", "--is-ancestor", sha, target])) {
			console.log(`  ✗ ${name}: ${sha} is NOT an ancestor of origin/main (diverged)`);
			problems.push(name);
			continue;
		}
		// Behind: does the undeployed gap touch runtime code (src/)?
		const srcChanges = sh("git", ["diff", "--name-only", `${sha}..${target}`, "--", "src/"]);
		if (srcChanges) {
			const files = srcChanges.split("\n").filter(Boolean);
			console.log(
				`  ✗ ${name}: ${sha} → ${targetShort} STALE — ${files.length} runtime file(s) undeployed:`,
			);
			for (const f of files.slice(0, 10)) console.log(`        ${f}`);
			if (files.length > 10) console.log(`        … and ${files.length - 10} more`);
			problems.push(name);
		} else {
			console.log(`  ~ ${name}: ${sha} → ${targetShort} behind, but no src/ changes (tooling/docs only)`);
		}
	}

	if (problems.length > 0) {
		console.error(
			`\n✗ ${problems.length} function(s) running stale runtime code: ${problems.join(", ")}`,
		);
		console.error("  Redeploy from a credentialed laptop: git push origin HEAD:main, or npm run deploy.");
		process.exit(1);
	}
	console.log("\n✓ all functions current (or behind only on tooling/docs).");
}

main();
