/**
 * scripts/db/gotrue-config.ts — detect when the local GoTrue (auth) container can no longer serve
 * the branded email templates declared in supabase/config.toml.
 *
 * THE BUG THIS GUARDS: config.toml declares each auth email via `content_path` (a branded HTML
 * file). At `supabase start` the CLI mounts those files and serves them through kong at
 * `/email/<name>.html`, then points GoTrue at the URLs (`GOTRUE_MAILER_TEMPLATES_*`). `supabase db
 * reset` reseeds the database but does NOT recreate the auth/kong containers (verified: same
 * container id + StartedAt before and after a reset), and a plain `podman restart` keeps the same
 * mount. So on the ONE shared local stack, a stack started from a config without working template
 * serving keeps 404-ing that kong route indefinitely. When GoTrue can't load a configured template
 * it falls back to its COMPILED-IN default — whose confirmation subject is the Title-Case
 * "Confirm Your Email" — which silently fails exactly the four email/auth E2E specs that assert on
 * the subject: auth-onboarding (confirmation + recovery), profile-settings (email change), and
 * registration-approval (confirmation).
 *
 * WHY WE PROBE THE ROUTE, NOT THE SUBJECT ENV: the CLI bakes the subjects into the container as
 * `GOTRUE_MAILER_SUBJECTS_*` env *correctly* even while the template route 404s — so comparing
 * those env vars to config.toml reports "in_sync" during the exact failure (the subject env is
 * right; GoTrue just ignores it along with the template when the template URL won't load). The only
 * signal that reflects the real failure is whether the kong template route actually serves our
 * file. We probe it the way GoTrue does: fetch the configured URL from INSIDE the auth container.
 *
 * The only CLI path that re-mounts the templates and re-registers the route is a full `supabase
 * stop && start` recreate (`supabase start` won't recreate a single removed service while the stack
 * is "already running"). So:
 *   - db:reset auto-reconciles: detect drift here (one bounded probe), and only when drifted pay the
 *     ~35s stop+start (reset.ts) — the common in-sync reset stays cheap.
 *   - db:doctor (the pre-push gate's preflight) uses this as a read-only tripwire: fail loud with
 *     the fix command instead of surfacing as four cryptic Playwright failures.
 *
 * The kong static-file route is all-or-nothing (every /email/*.html is mounted together by the same
 * `supabase start`), so probing the confirmation template alone faithfully reports route health and
 * keeps the doctor preflight to a single container round-trip. The parse/compare logic is pure and
 * unit-tested (tests/scripts/gotrue-config.test.ts); only `inspectAuthContainerEnv` /
 * `probeTemplateRoute` / `detectGoTrueDrift` touch the container engine.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { resolvePodmanBinary } from "./container-engine";

/** The single shared local stack's auth container (project_id "stocktextalerts"). */
const AUTH_CONTAINER_NAME = "supabase_auth_stocktextalerts";

/** Bound the `podman` probes: db:doctor advertises a fast preflight, and a wedged Podman engine can
 * hang `podman inspect`/`exec` indefinitely (the documented "machine up ≠ engine healthy" mode). On
 * timeout, spawnSync returns a non-zero/null status → the caller reports `auth_unavailable`, which
 * doctor treats as warn-and-continue (never a false gate failure). */
const PODMAN_TIMEOUT_MS = 4_000;

/** config.toml email-template locations → the GoTrue env var holding each template's served URL. */
type TemplateKey = "confirmation" | "recovery" | "email_change" | "password_changed";

const TEMPLATE_ENV_KEYS: Record<TemplateKey, string> = {
	confirmation: "GOTRUE_MAILER_TEMPLATES_CONFIRMATION",
	recovery: "GOTRUE_MAILER_TEMPLATES_RECOVERY",
	email_change: "GOTRUE_MAILER_TEMPLATES_EMAIL_CHANGE",
	password_changed: "GOTRUE_MAILER_TEMPLATES_PASSWORD_CHANGED_NOTIFICATION",
};

/** Fully-qualified config.toml table that declares each template (TOML headers are the full path). */
const SECTION_TO_KEY = new Map<string, TemplateKey>([
	["auth.email.template.confirmation", "confirmation"],
	["auth.email.template.recovery", "recovery"],
	["auth.email.template.email_change", "email_change"],
	["auth.email.notification.password_changed", "password_changed"],
]);

/** Which template the route probe checks, in priority order — the kong route is all-or-nothing, so
 * the first declared template stands in for all of them. Confirmation first because it backs the
 * most E2E specs. */
const CANARY_PRIORITY: TemplateKey[] = [
	"confirmation",
	"recovery",
	"email_change",
	"password_changed",
];

export type ExpectedTemplate = { key: TemplateKey; envKey: string; contentPath: string };

export type ProbeResult =
	| { kind: "http"; status: number; body: string }
	| { kind: "unreachable"; detail: string };

export type TemplateMismatch = {
	key: TemplateKey;
	envKey: string;
	url: string | null;
	/** Why GoTrue will fall back to its default template (and default subject). */
	reason: "template_env_missing" | "route_unavailable" | "content_mismatch";
	detail: string;
};

type DriftVerdict =
	| { status: "in_sync" }
	| { status: "drifted"; mismatches: TemplateMismatch[] }
	| { status: "auth_unavailable"; reason: string };

/**
 * Parse the email templates config.toml declares — the source of truth for what GoTrue *should*
 * serve. Only templates with a `content_path` are returned, so removing one from config.toml stops
 * it being enforced (rather than asserting against a stale default). Hand-parsed (no TOML lib — this
 * fleet declares none) by tracking the current `[table]` header and capturing its `content_path`.
 */
export function readExpectedTemplates(configToml: string): ExpectedTemplate[] {
	const found = new Map<TemplateKey, string>();
	let currentKey: TemplateKey | undefined;
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
		// `content_path = "..."` (or single-quoted), tolerating a trailing comment. Paths are
		// first-party and contain no embedded quote of the same kind, so the backreference closes.
		const match = line.match(/^content_path\s*=\s*(["'])(.*)\1\s*(?:#.*)?$/);
		if (match?.[2] !== undefined && match[2].length > 0) {
			found.set(currentKey, match[2]);
		}
	}

	const out: ExpectedTemplate[] = [];
	for (const key of CANARY_PRIORITY) {
		const contentPath = found.get(key);
		if (contentPath !== undefined) {
			out.push({ key, envKey: TEMPLATE_ENV_KEYS[key], contentPath });
		}
	}
	return out;
}

/**
 * Extract `GOTRUE_MAILER_TEMPLATES_*` values from a container's env, given as `KEY=value` lines (the
 * `podman inspect .Config.Env` shape). Splits on the FIRST `=` so URLs containing `=` survive.
 */
export function parseContainerTemplateUrls(envLines: string[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const line of envLines) {
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const key = line.slice(0, eq);
		if (key.startsWith("GOTRUE_MAILER_TEMPLATES_")) {
			map.set(key, line.slice(eq + 1));
		}
	}
	return map;
}

/**
 * Normalize a template body for comparison: collapse CRLF→LF and trim trailing whitespace, so a
 * benign trailing newline added by kong/the CLI never reads as content drift (and false-fails the
 * gate). The served body is otherwise byte-identical to the on-disk file.
 */
export function normalizeTemplateBody(body: string): string {
	return body.replace(/\r\n/g, "\n").replace(/\s+$/, "");
}

/**
 * Pure verdict for the canary template: given the expected on-disk content, the URL GoTrue is
 * pointed at, and the probe result, decide whether GoTrue can serve our template. A `null` URL means
 * the container has no `GOTRUE_MAILER_TEMPLATES_*` for this template at all (it will use the
 * default). Returns the mismatch, or `null` when the route serves our template verbatim.
 */
export function evaluateCanaryProbe(
	expected: ExpectedTemplate,
	localContent: string,
	url: string | null,
	probe: ProbeResult,
): TemplateMismatch | null {
	if (url === null) {
		return {
			key: expected.key,
			envKey: expected.envKey,
			url: null,
			reason: "template_env_missing",
			detail: `${expected.envKey} is not set on the auth container — GoTrue will use its default template`,
		};
	}
	if (probe.kind === "http" && probe.status !== 200) {
		return {
			key: expected.key,
			envKey: expected.envKey,
			url,
			reason: "route_unavailable",
			detail: `template route returned HTTP ${probe.status} — GoTrue will use its default template`,
		};
	}
	if (
		probe.kind === "http" &&
		normalizeTemplateBody(probe.body) !== normalizeTemplateBody(localContent)
	) {
		return {
			key: expected.key,
			envKey: expected.envKey,
			url,
			reason: "content_mismatch",
			detail: `template route serves content that differs from ${expected.contentPath}`,
		};
	}
	return null;
}

/**
 * Read the running auth container's env via `podman inspect`. Uses the podman CLI directly (its own
 * machine connection), so — unlike the Supabase CLI — it needs NO `DOCKER_HOST`, and works in
 * db:doctor which never wires one. Bounded by PODMAN_TIMEOUT_MS so a wedged engine can't hang the
 * preflight. Returns a reason on any failure (container absent, podman missing, timeout).
 */
function inspectAuthContainerEnv(): { ok: true; env: string[] } | { ok: false; reason: string } {
	const result = spawnSync(
		resolvePodmanBinary(),
		["inspect", AUTH_CONTAINER_NAME, "--format", "{{range .Config.Env}}{{println .}}{{end}}"],
		{ encoding: "utf8", timeout: PODMAN_TIMEOUT_MS },
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

/** Parse the HTTP status code from busybox wget's `-S` output (response headers go to stderr as
 * `  HTTP/1.1 404 Not Found`). Returns the LAST status line's code, or null if none is present. */
export function parseWgetStatus(stderr: string): number | null {
	let status: number | null = null;
	for (const m of stderr.matchAll(/HTTP\/\d(?:\.\d)?\s+(\d{3})/g)) {
		if (m[1] !== undefined) status = Number.parseInt(m[1], 10);
	}
	return status;
}

/**
 * Fetch a kong template URL the way GoTrue does — from INSIDE the auth container, over the container
 * network. `-S` writes the response status line to stderr; `-O -` writes the body to stdout. A
 * parsed HTTP status (200 or an error like 404) is a definitive answer; anything else (podman/exec
 * failed, wget missing, no status line) is `unreachable` — a probe gap, not drift. We deliberately
 * omit `-q`: on some busybox builds `-q` can suppress the `-S` header block, which would hide a
 * healthy 200's status line; the extra progress noise on stderr is harmless (parseWgetStatus only
 * matches HTTP status lines).
 */
function probeTemplateRoute(url: string): ProbeResult {
	const result = spawnSync(
		resolvePodmanBinary(),
		["exec", AUTH_CONTAINER_NAME, "wget", "-S", "-T", "3", "-O", "-", url],
		{ encoding: "utf8", timeout: PODMAN_TIMEOUT_MS },
	);
	if (result.error) {
		return { kind: "unreachable", detail: result.error.message };
	}
	const status = parseWgetStatus(result.stderr ?? "");
	if (status === null) {
		return {
			kind: "unreachable",
			detail: (result.stderr ?? "").trim() || "wget produced no HTTP status line",
		};
	}
	return { kind: "http", status, body: result.stdout ?? "" };
}

/**
 * Full drift detection: can the running auth container serve config.toml's branded email templates?
 * `in_sync` when the canary template route serves our file; `drifted` with the specific reason
 * (route 404, content mismatch, or the template env is unset); or `auth_unavailable` if config.toml,
 * the container, or the probe can't be read (caller decides the meaning — doctor warns, reset
 * recreates).
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

	const expected = readExpectedTemplates(configToml);
	// Nothing declared → nothing to enforce (a config that defers to GoTrue defaults).
	if (expected.length === 0) return { status: "in_sync" };

	// content_path is relative to the project root (where the Supabase CLI runs), i.e. the parent of
	// the supabase/ dir that holds config.toml.
	const repoRoot = path.dirname(path.dirname(configPath));
	const [canary] = expected;
	if (canary === undefined) return { status: "in_sync" };
	let localContent: string;
	try {
		localContent = fs.readFileSync(path.resolve(repoRoot, canary.contentPath), "utf8");
	} catch (err) {
		return {
			status: "auth_unavailable",
			reason: `cannot read template ${canary.contentPath}: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	const inspected = inspectAuthContainerEnv();
	if (!inspected.ok) return { status: "auth_unavailable", reason: inspected.reason };

	const url = parseContainerTemplateUrls(inspected.env).get(canary.envKey) ?? null;
	// A missing template env is a definitive drift (GoTrue points nowhere → it uses the default), so
	// it needs no probe; otherwise probe the route the way GoTrue would.
	const probe: ProbeResult =
		url === null ? { kind: "unreachable", detail: "" } : probeTemplateRoute(url);
	if (url !== null && probe.kind === "unreachable") {
		return {
			status: "auth_unavailable",
			reason: `could not probe ${canary.envKey} route: ${probe.detail}`,
		};
	}

	const mismatch = evaluateCanaryProbe(canary, localContent, url, probe);
	return mismatch === null ? { status: "in_sync" } : { status: "drifted", mismatches: [mismatch] };
}
