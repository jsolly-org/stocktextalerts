/**
 * scripts/db/container-engine.ts — point the Supabase CLI at the local container engine.
 *
 * The Supabase CLI talks to the container engine through Go's Docker SDK, which reads the
 * `DOCKER_HOST` env var (falling back to `/var/run/docker.sock`). StockTextAlerts local dev
 * uses Podman (rootless, `podman machine` on macOS), and two things break the fallback:
 *
 *   1. Podman's API socket lives at an ephemeral path under `$TMPDIR` (`/var/folders/...`) that
 *      changes on every reboot / machine recreation — so a hardcoded value goes stale.
 *   2. The `/var/run/docker.sock` docker-compat symlink is NOT created automatically (it needs
 *      `podman-mac-helper install` / Podman Desktop). When it does exist it can point at Docker
 *      Desktop's own socket — which is exactly what broke `db:bootstrap` on 2026-06-24: the
 *      symlink survived a Docker uninstall and pointed at a dead path while the Podman machine
 *      was healthy at its own socket.
 *
 * So we derive `DOCKER_HOST` at runtime from `podman machine inspect`, the canonical fresh-machine
 * wiring. The db:* scripts call `ensureContainerEngineEnv()` before invoking the CLI, so local
 * Supabase boots with no manual shell surgery.
 *
 * NAMING: `DOCKER_HOST` is the one Docker-named contract we can't drop — the Supabase CLI (and
 * `sam local invoke`) require that exact env var. Everywhere we control the vocabulary we speak in
 * vendor-neutral "container engine" terms; only this adapter point touches the Docker name.
 *
 * DESIGN CHOICE (shell out to Podman vs. read containers.conf / CONTAINER_HOST): we shell out to
 * `podman machine inspect` directly. This repo's local Supabase stack is Podman-only with no
 * second-engine requirement,
 * so the simpler, explicit path wins over an indirection that would let the same code target a
 * different engine (rules/code-style.md — clarity now over flexibility later). Podman's own tools
 * resolve via the vendor-neutral `CONTAINER_HOST` chain, but the Supabase CLI does not read it, so
 * indirecting through it would buy nothing here.
 *
 * See docs/local-supabase.md → "Container engine wiring".
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..", "..");

const PODMAN_MACHINE_START_TIMEOUT_MS = 120_000;

/** Breadcrumb to stderr (never stdout): the db:gen-types wrapper redirects this module's caller's
 * stdout into the generated types file, so any stdout write here corrupts that file. stderr is the
 * correct channel for a CLI diagnostic regardless. */
function note(message: string): void {
	process.stderr.write(`${message}\n`);
}

/** Resolve the Podman binary. The `/opt/podman/bin` install location isn't on the default PATH
 * (especially in the non-interactive npm/pre-commit environment), so prefer it before a bare lookup. */
export function resolvePodmanBinary(): string {
	const candidate = "/opt/podman/bin/podman";
	return fs.existsSync(candidate) ? candidate : "podman";
}

/** Resolve the repo-pinned Supabase CLI, falling back to a global install. */
export function resolveSupabaseCli(): string {
	const localCli = path.join(projectRoot, "node_modules", ".bin", "supabase");
	return fs.existsSync(localCli) ? localCli : "supabase";
}

const NO_ENGINE_HINT = [
	"",
	"💡 No container engine reachable for the local Supabase stack.",
	"   StockTextAlerts local dev uses Podman (rootless, `podman machine` on macOS).",
	"   Start it:        podman machine start",
	"   First-time init: podman machine init   (then `podman machine start`)",
	"   Then retry:      npm run db:bootstrap",
	"",
].join("\n");

export const PODMAN_STORAGE_CORRUPTION_HINT = [
	"",
	"💡 Podman VM storage looks corrupted (overlay graph driver error).",
	"   Repair (destructive to containers/images in the VM):",
	"     podman machine stop",
	"     podman machine rm podman-machine-default",
	"     podman machine init && podman machine start",
	"     npm run db:bootstrap",
	"",
].join("\n");

type EngineState = { running: boolean; socketPath: string };

/** Parse `unix://…` into a filesystem path; null for non-unix schemes. */
export function parseUnixDockerHost(dockerHost: string): string | null {
	const match = /^unix:\/\/(.+)$/u.exec(dockerHost.trim());
	return match?.[1] ?? null;
}

/** True when the unix socket path exists and the engine API responds. */
export function isDockerHostReachable(dockerHost: string): boolean {
	const socketPath = parseUnixDockerHost(dockerHost);
	if (!socketPath) {
		return false;
	}
	try {
		fs.accessSync(socketPath, fs.constants.R_OK | fs.constants.W_OK);
	} catch {
		return false;
	}
	return isContainerEngineApiReachable(dockerHost);
}

/** Best-effort ping against the docker-compat API (Podman locally; Docker on CI). */
function isContainerEngineApiReachable(dockerHost: string): boolean {
	const env = { ...process.env, DOCKER_HOST: dockerHost };
	for (const cmd of [resolvePodmanBinary(), "docker"]) {
		const result = spawnSync(cmd, ["version", "--format", "{{.Client.Version}}"], {
			encoding: "utf8",
			env,
			timeout: 5_000,
		});
		if (result.status === 0) {
			return true;
		}
	}
	return false;
}

/** Supabase/Podman output indicating the VM's container storage layer is broken. */
export function isPodmanStorageCorruptionError(output: string): boolean {
	return (
		output.includes("readlink") &&
		output.includes("overlay") &&
		output.includes("invalid argument")
	);
}

/**
 * Inspect the local Podman machine(s) for a reachable docker-compat API socket. Returns null if
 * Podman is absent or has no machine — the caller turns that into an actionable error.
 *
 * `podman machine inspect` with no name argument emits one line PER machine (it's `[MACHINE...]`),
 * so we parse every row and prefer the first *running* one: a stopped default machine sitting next
 * to a second running machine must still resolve a reachable engine rather than spuriously failing.
 * (`inspect` doesn't expose `.Default`, so there's no cheap way to single out the default here —
 * "first running" satisfies the goal: don't fail loud when an engine is actually up.)
 */
function inspectPodmanMachine(): EngineState | null {
	const result = spawnSync(
		resolvePodmanBinary(),
		["machine", "inspect", "--format", "{{.State}}\t{{.ConnectionInfo.PodmanSocket.Path}}"],
		{ encoding: "utf8" },
	);

	if (result.status !== 0 || !result.stdout) {
		// Surface an unexpected Podman error (corrupt install, permissions) instead of flattening it
		// into the routine "no machine" hint. A bare "no machine" case has empty stdout + stderr.
		const detail = result.error?.message ?? result.stderr?.trim();
		if (detail) note(`container-engine — \`podman machine inspect\` failed: ${detail}`);
		return null;
	}

	const rows = result.stdout
		.trim()
		.split("\n")
		.map((line) => {
			const [state, socketPath] = line.split("\t");
			return { running: state?.trim() === "running", socketPath: socketPath?.trim() ?? "" };
		})
		.filter((row) => row.socketPath);

	// Prefer a running machine; fall back to the first row so the caller reports "not running".
	// `?? null` keeps the return type honest under noUncheckedIndexedAccess (rows may be empty).
	return rows.find((row) => row.running) ?? rows[0] ?? null;
}

/** Start the default Podman machine when it exists but is stopped (local dev/agents only). */
export function ensurePodmanMachineRunning(): boolean {
	if (process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") {
		return true;
	}

	const engine = inspectPodmanMachine();
	if (!engine) {
		return false;
	}
	if (engine.running) {
		return true;
	}

	note("container-engine — Podman machine stopped; starting (may take ~30s)…");
	const result = spawnSync(resolvePodmanBinary(), ["machine", "start"], {
		encoding: "utf8",
		timeout: PODMAN_MACHINE_START_TIMEOUT_MS,
	});
	if (result.stdout) process.stderr.write(result.stdout);
	if (result.stderr) process.stderr.write(result.stderr);

	if (result.status !== 0) {
		const detail = result.error?.message ?? result.stderr?.trim() ?? "podman machine start failed";
		note(`container-engine — ${detail}`);
		return false;
	}

	return inspectPodmanMachine()?.running === true;
}

function applyPodmanDockerHost(engine: EngineState): void {
	const dockerHost = `unix://${engine.socketPath}`;
	process.env.DOCKER_HOST = dockerHost;
	note(`container-engine — derived DOCKER_HOST from Podman machine socket: ${dockerHost}`);
}

/**
 * Ensure `DOCKER_HOST` points at a live local container engine, mutating `process.env` in place so
 * every child process the calling script spawns inherits it. Idempotent.
 *
 * - Validates an existing `DOCKER_HOST` (shell exports go stale after Podman machine restarts).
 * - On local machines, starts a stopped Podman VM before deriving the socket path.
 * - If no engine is reachable, prints the actionable hint and `process.exit(1)`s.
 */
export function ensureContainerEngineEnv(): void {
	const existing = process.env.DOCKER_HOST?.trim();
	if (existing && isDockerHostReachable(existing)) {
		note(`container-engine — using DOCKER_HOST from environment: ${existing}`);
		return;
	}

	if (existing) {
		note(
			`container-engine — ignoring stale DOCKER_HOST (${existing}); deriving from Podman machine`,
		);
		delete process.env.DOCKER_HOST;
	}

	if (!ensurePodmanMachineRunning()) {
		process.stderr.write(NO_ENGINE_HINT);
		process.exit(1);
	}

	const engine = inspectPodmanMachine();
	if (!engine?.running) {
		process.stderr.write(NO_ENGINE_HINT);
		process.exit(1);
	}

	applyPodmanDockerHost(engine);
}
