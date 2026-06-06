import { type ChildProcess, spawn } from "node:child_process";

const E2E_DEV_BASE = "http://localhost:4322";
const HTTP_TEST_PORT = 4325;
const HTTP_TEST_BASE = `http://localhost:${HTTP_TEST_PORT}`;

let dedicatedServer: ChildProcess | null = null;
let resolvedBase: string | null = null;

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

function startDedicatedServer(): ChildProcess {
	const child = spawn("npm", ["run", "dev", "--", "--port", String(HTTP_TEST_PORT)], {
		cwd: process.cwd(),
		env: {
			...process.env,
			MODE: "test",
			SKIP_VENDOR_HTTP_IN_TEST: "1",
			SITE_URL: HTTP_TEST_BASE,
			EMAIL_SMTP_HOST: process.env.EMAIL_SMTP_HOST ?? "localhost",
			EMAIL_SMTP_PORT: process.env.EMAIL_SMTP_PORT ?? "1025",
		},
		stdio: "pipe",
	});
	child.on("exit", () => {
		if (dedicatedServer === child) {
			dedicatedServer = null;
		}
	});
	return child;
}

/** Resolve a running Astro dev server for HTTP integration tests. */
export async function ensureHttpTestServer(): Promise<string> {
	if (resolvedBase) {
		return resolvedBase;
	}

	if (await probe(E2E_DEV_BASE)) {
		resolvedBase = E2E_DEV_BASE;
		return resolvedBase;
	}

	if (await probe(HTTP_TEST_BASE)) {
		resolvedBase = HTTP_TEST_BASE;
		return resolvedBase;
	}

	dedicatedServer = startDedicatedServer();
	await waitForProbe(HTTP_TEST_BASE, 120_000);
	resolvedBase = HTTP_TEST_BASE;
	return resolvedBase;
}
