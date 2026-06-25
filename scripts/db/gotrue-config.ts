/**
 * scripts/db/gotrue-config.ts — detect when the local GoTrue (auth) container's email config has
 * drifted from supabase/config.toml.
 *
 * THE BUG THIS GUARDS: the Supabase CLI bakes config.toml's email *subjects* into the auth
 * container as `GOTRUE_MAILER_SUBJECTS_*` env vars at `supabase start` time. `supabase db reset`
 * reseeds the database but does NOT recreate the auth container (verified: same container id +
 * StartedAt before and after a reset), and a plain `podman restart` keeps the same baked env. So on
 * the ONE shared local stack, a long-lived auth container started from an older/default config.toml
 * keeps serving the wrong email subjects (Supabase's default "Confirm Your Signup" instead of
 * "Confirm your email — StockTextAlerts") indefinitely. That silently fails exactly the four
 * email/auth E2E specs that assert on the subject: auth-onboarding (confirmation + recovery),
 * profile-settings (email change), and registration-approval (confirmation).
 *
 * The only CLI path that makes GoTrue re-read config.toml is a full `supabase stop && supabase
 * start` recreate — `supabase start` refuses to recreate a single removed service while the stack
 * is "already running". So:
 *   - db:reset auto-reconciles: detect drift here (cheap), and only when drifted pay the ~35s
 *     stop+start (reset.ts) — the cheap path stays cheap.
 *   - db:doctor (the pre-push gate's preflight) uses this as a read-only tripwire: fail loud with
 *     the fix command instead of surfacing as four cryptic Playwright failures.
 *
 * The parse/compare logic is pure and unit-tested (tests/scripts/gotrue-config.test.ts); only
 * `inspectAuthContainerEnv` / `detectGoTrueDrift` touch the container engine.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";

import { resolvePodmanBinary } from "./container-engine";

/** The single shared local stack's auth container (project_id "stocktextalerts"). */
const AUTH_CONTAINER_NAME = "supabase_auth_stocktextalerts";

/** Bound the `podman inspect` probe: db:doctor advertises a ~300ms preflight, and a wedged Podman
 * engine can hang `podman inspect` indefinitely (the documented "machine up ≠ engine healthy" mode).
 * On timeout, spawnSync returns a non-zero/null status → `inspectAuthContainerEnv` reports
 * `auth_unavailable`, which doctor treats as warn-and-continue (never a false gate failure). */
const INSPECT_TIMEOUT_MS = 3_000;

/** config.toml email-subject locations → the GoTrue env var the CLI renders each into. */
type SubjectKey = "confirmation" | "recovery" | "email_change" | "password_changed";

const SUBJECT_ENV_KEYS: Record<SubjectKey, string> = {
	confirmation: "GOTRUE_MAILER_SUBJECTS_CONFIRMATION",
	recovery: "GOTRUE_MAILER_SUBJECTS_RECOVERY",
	email_change: "GOTRUE_MAILER_SUBJECTS_EMAIL_CHANGE",
	password_changed: "GOTRUE_MAILER_SUBJECTS_PASSWORD_CHANGED_NOTIFICATION",
};

/** Fully-qualified config.toml table that declares each subject (TOML headers are the full path). */
const SECTION_TO_KEY = new Map<string, SubjectKey>([
	["auth.email.template.confirmation", "confirmation"],
	["auth.email.template.recovery", "recovery"],
	["auth.email.template.email_change", "email_change"],
	["auth.email.notification.password_changed", "password_changed"],
]);

export type ExpectedSubject = { key: SubjectKey; envKey: string; subject: string };

export type SubjectMismatch = { envKey: string; expected: string; actual: string | null };

type DriftVerdict =
	| { status: "in_sync" }
	| { status: "drifted"; mismatches: SubjectMismatch[] }
	| { status: "auth_unavailable"; reason: string };

/**
 * Parse the email subjects config.toml declares — the source of truth for what GoTrue *should*
 * serve. Only subjects actually present are returned, so removing one from config.toml stops it
 * being enforced (rather than asserting against a stale default).
 */
export function readExpectedSubjects(configToml: string): ExpectedSubject[] {
	// Hand-parse rather than pull in a TOML lib: this fleet has no declared TOML dependency (doctor.ts
	// extracts project_id with a regex for the same reason), and we need only the `subject` of four
	// known tables. Track the current `[table]` header and capture its `subject = "..."` line.
	const found = new Map<SubjectKey, string>();
	let currentKey: SubjectKey | undefined;
	for (const rawLine of configToml.split("\n")) {
		const line = rawLine.trim();
		if (line.startsWith("[")) {
			const header = line
				.replace(/^\[+\s*/, "")
				.replace(/\s*\]+.*$/, "")
				.trim();
			currentKey = SECTION_TO_KEY.get(header);
			continue;
		}
		if (currentKey === undefined) continue;
		// `subject = "..."` (or single-quoted), tolerating a trailing comment. Subjects are first-party
		// and contain no embedded quote of the same kind, so the backreference closes correctly.
		const match = line.match(/^subject\s*=\s*(["'])(.*)\1\s*(?:#.*)?$/);
		if (match?.[2] !== undefined) {
			found.set(currentKey, match[2]);
		}
	}

	const out: ExpectedSubject[] = [];
	for (const key of Object.keys(SUBJECT_ENV_KEYS) as SubjectKey[]) {
		const subject = found.get(key);
		if (subject !== undefined && subject.length > 0) {
			out.push({ key, envKey: SUBJECT_ENV_KEYS[key], subject });
		}
	}
	return out;
}

/**
 * Extract `GOTRUE_MAILER_SUBJECTS_*` values from a container's env, given as `KEY=value` lines
 * (the `podman inspect .Config.Env` shape). Splits on the FIRST `=` so subjects containing `=`
 * survive intact.
 */
export function parseContainerSubjects(envLines: string[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const line of envLines) {
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const key = line.slice(0, eq);
		if (key.startsWith("GOTRUE_MAILER_SUBJECTS_")) {
			map.set(key, line.slice(eq + 1));
		}
	}
	return map;
}

/**
 * Pure comparison: every expected subject that the container does not serve verbatim (different
 * value, or env var absent) is a mismatch. Exact string match — the em-dash in our subjects must
 * round-trip byte-for-byte.
 */
export function compareSubjects(
	expected: ExpectedSubject[],
	actual: Map<string, string>,
): { status: "in_sync" } | { status: "drifted"; mismatches: SubjectMismatch[] } {
	const mismatches: SubjectMismatch[] = [];
	for (const exp of expected) {
		const got = actual.get(exp.envKey) ?? null;
		if (got !== exp.subject) {
			mismatches.push({ envKey: exp.envKey, expected: exp.subject, actual: got });
		}
	}
	return mismatches.length === 0 ? { status: "in_sync" } : { status: "drifted", mismatches };
}

/**
 * Read the running auth container's env via `podman inspect`. Uses the podman CLI directly (its own
 * machine connection), so — unlike the Supabase CLI — it needs NO `DOCKER_HOST`, and works in
 * db:doctor which never wires one. Bounded by INSPECT_TIMEOUT_MS so a wedged engine can't hang the
 * preflight. Returns a reason on any failure (container absent, podman missing, timeout); the caller
 * decides whether that means "reconcile" (reset) or "can't tell" (doctor).
 */
function inspectAuthContainerEnv(): { ok: true; env: string[] } | { ok: false; reason: string } {
	const result = spawnSync(
		resolvePodmanBinary(),
		["inspect", AUTH_CONTAINER_NAME, "--format", "{{range .Config.Env}}{{println .}}{{end}}"],
		{ encoding: "utf8", timeout: INSPECT_TIMEOUT_MS },
	);
	if (result.status !== 0 || !result.stdout) {
		const reason =
			result.error?.message ?? result.stderr?.trim() ?? "podman inspect returned no output";
		return { ok: false, reason };
	}
	const env = result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	return { ok: true, env };
}

/**
 * Full drift detection: compare config.toml's declared subjects to the running auth container.
 * `in_sync` when every declared subject matches; `drifted` with the specific mismatches; or
 * `auth_unavailable` if config.toml or the container can't be read (caller decides the meaning).
 */
export function detectGoTrueDrift(configPath: string): DriftVerdict {
	let configToml: string;
	try {
		configToml = fs.readFileSync(configPath, "utf8");
	} catch (err) {
		return {
			status: "auth_unavailable",
			reason: `cannot read ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	const expected = readExpectedSubjects(configToml);
	// Nothing declared → nothing to enforce (e.g. a config that defers to GoTrue defaults).
	if (expected.length === 0) return { status: "in_sync" };

	const inspected = inspectAuthContainerEnv();
	if (!inspected.ok) return { status: "auth_unavailable", reason: inspected.reason };

	return compareSubjects(expected, parseContainerSubjects(inspected.env));
}
