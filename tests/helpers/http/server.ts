import { type ChildProcess, spawn, spawnSync } from "node:child_process";

const E2E_DEV_BASE = "http://127.0.0.1:4322";
const HTTP_TEST_HOST = "127.0.0.1";
const HTTP_TEST_PORT = 4325;
const HTTP_TEST_BASE = `http://${HTTP_TEST_HOST}:${HTTP_TEST_PORT}`;

const RUNTIME_KEY = "__stocktextalertsHttpTestRuntime__";

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
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error(`HTTP test server did not become ready at ${baseUrl}`);
}

function stopAstroDevLock(): void {
	spawnSync("./node_modules/.bin/astro", ["dev", "stop"], {
		cwd: process.cwd(),
		stdio: "ignore",
	});
}

function stopDedicatedServer(): void {
	const state = runtime();
	if (state.dedicatedServer && !state.dedicatedServer.killed) {
		const pid = state.dedicatedServer.pid;
		if (pid && process.platform !== "win32") {
			try {
				process.kill(-pid, "SIGTERM");
			} catch {
				state.dedicatedServer.kill("SIGTERM");
			}
		} else {
			state.dedicatedServer.kill("SIGTERM");
		}
	}
	state.dedicatedServer = null;
	if (state.resolvedBase === HTTP_TEST_BASE) {
		state.resolvedBase = null;
	}
	stopAstroDevLock();
}

function startDedicatedServer(): ChildProcess {
	const child = spawn(
		"npm",
		["run", "dev", "--", "--port", String(HTTP_TEST_PORT), "--host", HTTP_TEST_HOST],
		{
			cwd: process.cwd(),
			env: {
				...process.env,
				MODE: "test",
				SKIP_VENDOR_HTTP_IN_TEST: "1",
				SITE_URL: HTTP_TEST_BASE,
				EMAIL_SMTP_HOST: process.env.EMAIL_SMTP_HOST ?? "localhost",
				EMAIL_SMTP_PORT: process.env.EMAIL_SMTP_PORT ?? "1025",
			},
			// Avoid pipe backpressure killing the dev server in CI.
			stdio: "ignore",
			detached: process.platform !== "win32",
		},
	);
	child.on("exit", () => {
		const state = runtime();
		if (state.dedicatedServer === child) {
			state.dedicatedServer = null;
		}
		if (state.resolvedBase === HTTP_TEST_BASE) {
			state.resolvedBase = null;
		}
	});
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
	stopDedicatedServer();

	const existing = await resolveLiveBase([E2E_DEV_BASE, HTTP_TEST_BASE]);
	if (existing) {
		state.resolvedBase = existing;
		return existing;
	}

	state.dedicatedServer = startDedicatedServer();
	await waitForProbe(HTTP_TEST_BASE, 120_000);
	state.resolvedBase = HTTP_TEST_BASE;
	return HTTP_TEST_BASE;
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

/** Stop a dedicated HTTP test server started by this Vitest worker. */
export function shutdownHttpTestServer(): void {
	const state = runtime();
	state.startPromise = null;
	stopDedicatedServer();
}

/** Clear Astro 7's project-wide dev lock after Vitest HTTP integration tests. */
export function stopAstroDevLockAfterHttpTests(): void {
	stopAstroDevLock();
}
