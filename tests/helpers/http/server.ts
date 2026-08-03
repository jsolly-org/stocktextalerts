import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const E2E_DEV_BASE = "http://127.0.0.1:4322";
const HTTP_TEST_HOST = "127.0.0.1";
const HTTP_TEST_PORT = 4325;
const HTTP_TEST_BASE = `http://${HTTP_TEST_HOST}:${HTTP_TEST_PORT}`;

const RUNTIME_KEY = "__stocktextalertsHttpTestRuntime__";

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
/**
 * Cross-worker ownership of the single HTTP test dev server.
 *
 * The server is shared by every `tests/pages/http/**` file, but Vitest runs those files in
 * separate worker processes, so "who starts it" and "who stops it" cannot live in module
 * state. The lock directory is the arbitration point: `mkdir` is atomic, so exactly one
 * worker spawns and the rest wait on the readiness probe. The pid inside it lets the
 * run-level teardown (tests/global-setup.ts) kill a server it never started.
 *
 * Nothing stops the server mid-run. It used to be torn down in the `afterAll` that
 * tests/setup.ts registers for *every* test file, which is why these files had to be
 * serialized: with file parallelism on, one file finishing killed the dev server another
 * file was still using (`TypeError: fetch failed`), and `astro dev stop` cleared the
 * project dev lock underneath it for good measure.
 */
const lockDir = path.join(projectRoot, ".astro", "http-test-server.lock");
const pidFile = path.join(lockDir, "server.pid");

const START_TIMEOUT_MS = 120_000;
/** How long a lock with no live server and no live owner may sit before we break it. */
const STALE_LOCK_MS = 20_000;

type HttpTestRuntime = {
	dedicatedServer: ChildProcess | null;
	resolvedBase: string | null;
	startPromise: Promise<string> | null;
};

function runtime(): HttpTestRuntime {
	const globalState = globalThis as typeof globalThis & {
		[RUNTIME_KEY]?: HttpTestRuntime;
	};
	if (!globalState[RUNTIME_KEY]) {
		globalState[RUNTIME_KEY] = {
			dedicatedServer: null,
			resolvedBase: null,
			startPromise: null,
		};
	}
	return globalState[RUNTIME_KEY];
}

async function delay(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

async function probe(baseUrl: string): Promise<boolean> {
	try {
		const response = await fetch(`${baseUrl}/`, {
			redirect: "manual",
			signal: AbortSignal.timeout(2_000),
		});
		return response.status === 200;
	} catch {
		return false;
	}
}

async function waitForProbe(baseUrl: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await probe(baseUrl)) {
			return;
		}
		await delay(500);
	}
	throw new Error(`HTTP test server did not become ready at ${baseUrl}`);
}

function readOwnerPid(): number | null {
	try {
		const pid = Number.parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
		return Number.isInteger(pid) && pid > 0 ? pid : null;
	} catch {
		return null;
	}
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Atomic across processes: `mkdir` fails with EEXIST when another worker holds the lock. */
function acquireSpawnLock(): boolean {
	fs.mkdirSync(path.dirname(lockDir), { recursive: true });
	try {
		fs.mkdirSync(lockDir);
		return true;
	} catch {
		return false;
	}
}

function releaseSpawnLock(): void {
	fs.rmSync(lockDir, { recursive: true, force: true });
}

/** A crashed run can leave the lock behind; break it only when nothing is behind it. */
function isLockStale(firstSeenAt: number): boolean {
	if (Date.now() - firstSeenAt < STALE_LOCK_MS) return false;
	const pid = readOwnerPid();
	return pid === null || !isAlive(pid);
}

function stopAstroDevLock(): void {
	spawnSync("./node_modules/.bin/astro", ["dev", "stop"], {
		cwd: process.cwd(),
		stdio: "ignore",
	});
}

function killServerProcess(pid: number): void {
	try {
		process.kill(process.platform === "win32" ? pid : -pid, "SIGTERM");
	} catch {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			// Already gone.
		}
	}
}

function startDedicatedServer(): ChildProcess {
	// Astro ≥7.0.6 skips vite-plugin-astro-server when process.env.VITEST is set
	// (so Vitest browser-mode / getViteConfig don't double-boot a server). The
	// dedicated `astro dev` child must NOT inherit that — otherwise / probes
	// 404 forever and HTTP integration tests time out.
	const env: NodeJS.ProcessEnv = {
		...process.env,
		MODE: "test",
		SITE_URL: HTTP_TEST_BASE,
		EMAIL_SMTP_HOST: process.env.EMAIL_SMTP_HOST ?? "localhost",
		EMAIL_SMTP_PORT: process.env.EMAIL_SMTP_PORT ?? "1025",
	};
	delete env.VITEST;
	delete env.VITEST_WORKER_ID;
	delete env.VITEST_POOL_ID;

	const child = spawn(
		"npm",
		["run", "dev", "--", "--port", String(HTTP_TEST_PORT), "--host", HTTP_TEST_HOST],
		{
			cwd: process.cwd(),
			env,
			// Avoid pipe backpressure killing the dev server in CI.
			stdio: "ignore",
			// Detached so the server outlives the worker that happened to win the lock:
			// other workers are still using it, and teardown kills the whole group.
			detached: process.platform !== "win32",
		},
	);
	// The worker that spawned it must not wait on it at exit.
	child.unref();
	return child;
}

async function resolveLiveBase(candidates: string[]): Promise<string | null> {
	for (const baseUrl of candidates) {
		if (await probe(baseUrl)) {
			return baseUrl;
		}
	}
	return null;
}

async function startHttpTestServer(): Promise<string> {
	const state = runtime();

	if (state.resolvedBase && (await probe(state.resolvedBase))) {
		return state.resolvedBase;
	}
	state.resolvedBase = null;

	const deadline = Date.now() + START_TIMEOUT_MS;
	let lockFirstSeenAt: number | null = null;

	while (Date.now() < deadline) {
		// Reuse anything already serving: a local `npm run test:e2e` dev server, or the
		// server another worker in this run started.
		const existing = await resolveLiveBase([E2E_DEV_BASE, HTTP_TEST_BASE]);
		if (existing) {
			state.resolvedBase = existing;
			return existing;
		}

		if (acquireSpawnLock()) {
			try {
				const child = startDedicatedServer();
				state.dedicatedServer = child;
				if (child.pid) {
					fs.writeFileSync(pidFile, String(child.pid));
				}
				await waitForProbe(HTTP_TEST_BASE, Math.max(deadline - Date.now(), 1));
				state.resolvedBase = HTTP_TEST_BASE;
				return HTTP_TEST_BASE;
			} catch (error) {
				// Leave nothing half-started behind for the next worker to wait on.
				shutdownHttpTestServer();
				throw error;
			}
		}

		// Another worker is booting it. Wait, unless the lock outlived its owner.
		lockFirstSeenAt ??= Date.now();
		if (isLockStale(lockFirstSeenAt)) {
			releaseSpawnLock();
			lockFirstSeenAt = null;
		}
		await delay(250);
	}

	throw new Error(`HTTP test server did not become ready at ${HTTP_TEST_BASE}`);
}

/** Resolve a running Astro dev server for HTTP integration tests. */
export async function ensureHttpTestServer(): Promise<string> {
	const state = runtime();
	if (!state.startPromise) {
		state.startPromise = startHttpTestServer().finally(() => {
			state.startPromise = null;
		});
	}
	return state.startPromise;
}

/**
 * Stop the run's HTTP test server. Run-level only: tests/global-setup.ts calls this in
 * `teardown()`, never a per-file hook, because other files may still be using the server.
 */
export function shutdownHttpTestServer(): void {
	const state = runtime();
	state.startPromise = null;
	// No lock means this run never started a server. Anything listening belongs to
	// someone else (a developer's `npm run dev`), so leave it alone.
	if (!fs.existsSync(lockDir) && state.dedicatedServer === null) {
		state.resolvedBase = null;
		return;
	}
	const pid = readOwnerPid() ?? state.dedicatedServer?.pid ?? null;
	if (pid !== null) {
		killServerProcess(pid);
	}
	state.dedicatedServer = null;
	if (state.resolvedBase === HTTP_TEST_BASE) {
		state.resolvedBase = null;
	}
	releaseSpawnLock();
	stopAstroDevLock();
}

/** Clear Astro 7's project-wide dev lock after Vitest HTTP integration tests. */
export function stopAstroDevLockAfterHttpTests(): void {
	stopAstroDevLock();
}
