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
 *
 * WHICH SIGNAL = AWS's own artifact fingerprint, not a self-asserted string. Each
 * code-only deploy (aws/deploy-web.sh) tags the function with:
 *   - Deploy-Sha256  = the CodeSha256 `update-function-code` returned (base64 SHA256
 *     of the exact zip AWS stored — server-computed, unspoofable).
 *   - Deploy-Commit  = the git commit the deploy built from.
 * This audit reads both tags AND the function's LIVE CodeSha256 in a single,
 * already-granted `aws lambda get-function` call (NOT `list-tags`, which needs an
 * un-granted lambda:ListTags), and checks two things:
 *   - INTEGRITY: live CodeSha256 == Deploy-Sha256 tag. A mismatch means the running
 *     bytes differ from what the pipeline recorded — an out-of-band edit (console
 *     hot-patch / raw update-function-code off-pipeline).
 *   - IDENTITY: Deploy-Commit resolves in git history and is origin/main (or a clean
 *     ancestor) — else the deployed code is behind / diverged.
 * The old `GIT_SHA` env field + CloudWatch-log scraping are gone: GIT_SHA went stale
 * on every code-only deploy (env vars untouched by update-function-code), and reading
 * a tag needs no recent invocation (closes the idle-cron blind spot, within an
 * authenticated session).
 *
 * Fails CLOSED:
 *   - aws CLI absent, fetch fails, or list returns zero functions → exit 1.
 *   - integrity mismatch, or a Deploy-Commit unknown to git / behind origin/main
 *     with src/ changes → exit 1.
 *   - a function that list-functions returned but get-function can't read
 *     (no read access / no CodeSha256) → exit 1 (untagged stays report-only).
 * Reported but NOT failed: tooling/docs-only drift (no src/ in the gap), and
 * functions with no Deploy-Sha256 tag yet (untagged — pre-rollout / never deployed).
 *
 * Read-only: lambda:ListFunctions + lambda:GetFunction + local git. No mutation.
 * Usage: npm run check:deploy-drift   (manual; needs AWS read creds)
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

/** Live CodeSha256 + Deploy-* tags for a function, or null if unreadable. */
function liveProvenance(
	fnName: string,
): { live: string | null; deploySha: string | null; commit: string | null } | null {
	let raw: string;
	try {
		raw = sh("aws", [
			"lambda",
			"get-function",
			"--function-name",
			fnName,
			"--query",
			"{live: Configuration.CodeSha256, tags: Tags}",
			"--output",
			"json",
		]);
	} catch {
		return null; // no function / no read access
	}
	const parsed = JSON.parse(raw) as { live: string | null; tags: Record<string, string> | null };
	const tags = parsed.tags ?? {};
	return {
		live: parsed.live,
		deploySha: tags["Deploy-Sha256"] ?? null,
		commit: tags["Deploy-Commit"] ?? null,
	};
}

function main(): void {
	// Presence-guard the system CLI (dependency-grounding: fail loud, don't assume PATH).
	try {
		sh("aws", ["--version"]);
	} catch {
		console.error("✗ aws CLI not found — install it (and authenticate) to audit deploy drift.");
		process.exit(1);
	}

	// Compare against the *fetched* remote tip — fail loud if the fetch fails, or the audit would
	// silently validate against a stale local origin/main and report a behind fleet as current.
	if (!gitOk(["fetch", "origin", "main", "--quiet"])) {
		console.error(
			"✗ git fetch origin main failed — refusing to audit against an unverified (possibly stale) origin/main.",
		);
		process.exit(1);
	}
	const target = sh("git", ["rev-parse", "origin/main"]);
	const targetShort = target.slice(0, 8);

	const raw = sh("aws", [
		"lambda",
		"list-functions",
		"--query",
		`Functions[?starts_with(FunctionName, '${FUNCTION_PREFIX}')].FunctionName`,
		"--output",
		"json",
	]);
	const fns = (JSON.parse(raw) as string[]).sort((a, b) => a.localeCompare(b));

	if (fns.length === 0) {
		console.error(
			`✗ no ${FUNCTION_PREFIX}* functions found — wrong account/region, or a broken read. Refusing to report "no drift".`,
		);
		process.exit(1);
	}

	console.log(`Deploy-drift audit — target origin/main = ${targetShort}\n`);

	const problems: string[] = [];
	const untagged: string[] = [];
	const unverifiable: string[] = [];
	for (const name of fns) {
		const p = liveProvenance(name);
		if (!p) {
			console.log(`  ? ${name}: get-function failed — cannot verify (no read access?)`);
			unverifiable.push(name);
			continue;
		}
		if (!p.live) {
			console.log(`  ? ${name}: get-function returned no CodeSha256 — cannot verify`);
			unverifiable.push(name);
			continue;
		}
		// Bootstrap: a function deployed before this rollout (or never deployed) has no tag yet.
		// Reported, not failed — check-deploy-functions owns "a function that SHOULD exist is missing".
		if (!p.deploySha || !p.commit) {
			console.log(`  ? ${name}: no Deploy-* tag yet — untagged (pre-rollout or never deployed)`);
			untagged.push(name);
			continue;
		}
		// INTEGRITY: the bytes AWS is running must equal what the pipeline recorded at deploy.
		if (p.live !== p.deploySha) {
			console.log(
				`  ✗ ${name}: live CodeSha256 ≠ Deploy-Sha256 tag — out-of-band code change (console edit / off-pipeline update-function-code)`,
			);
			problems.push(name);
			continue;
		}
		const commitShort = p.commit.slice(0, 8);
		// IDENTITY: resolve the recorded commit. Unknown = diverged / force-push.
		if (!gitOk(["rev-parse", "--verify", "--quiet", `${p.commit}^{commit}`])) {
			console.log(`  ✗ ${name}: Deploy-Commit ${commitShort} unknown to git history (diverged / force-push)`);
			problems.push(name);
			continue;
		}
		const commitFull = sh("git", ["rev-parse", `${p.commit}^{commit}`]);
		if (commitFull === target) {
			console.log(`  ✓ ${name}: ${commitShort} (current)`);
			continue;
		}
		if (!gitOk(["merge-base", "--is-ancestor", p.commit, target])) {
			console.log(`  ✗ ${name}: Deploy-Commit ${commitShort} is NOT an ancestor of origin/main (diverged)`);
			problems.push(name);
			continue;
		}
		// Behind origin/main: genuine drift only if the gap touches runtime code (src/).
		const srcChanges = sh("git", ["diff", "--name-only", `${p.commit}..${target}`, "--", "src/"]);
		if (srcChanges) {
			const files = srcChanges.split("\n").filter(Boolean);
			console.log(`  ✗ ${name}: ${commitShort} → ${targetShort} STALE — ${files.length} runtime file(s) undeployed:`);
			for (const f of files.slice(0, 10)) console.log(`        ${f}`);
			if (files.length > 10) console.log(`        … and ${files.length - 10} more`);
			problems.push(name);
		} else {
			console.log(`  ~ ${name}: ${commitShort} → ${targetShort} behind, but no src/ changes (tooling/docs only)`);
		}
	}

	if (untagged.length > 0) {
		console.log(`\n? ${untagged.length} function(s) untagged (no Deploy-* tag yet): ${untagged.join(", ")}`);
	}
	if (unverifiable.length > 0) {
		console.error(
			`\n✗ ${unverifiable.length} function(s) unverifiable (in list-functions but get-function failed): ${unverifiable.join(", ")}`,
		);
	}
	if (problems.length > 0) {
		console.error(`\n✗ ${problems.length} function(s) with deploy drift: ${problems.join(", ")}`);
		console.error("  Redeploy from a credentialed laptop: git push origin HEAD:main, or npm run deploy:code.");
	}
	if (problems.length > 0 || unverifiable.length > 0) {
		process.exit(1);
	}
	console.log("\n✓ all tagged functions current (or behind only on tooling/docs).");
}

main();
