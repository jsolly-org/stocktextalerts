import net from "node:net";
import { defineConfig } from "@playwright/test";
import { loadEnv } from "vite";

// Load .env / .env.local so smoke test helpers (which run in plain Node, not
// Vite) can access env vars like SUPABASE_URL via process.env.
const env = loadEnv("test", process.cwd(), "");
for (const [key, value] of Object.entries(env)) {
	if (process.env[key] === undefined) {
		process.env[key] = value;
	}
}

const DEV_PORT = 4321;
const FALLBACK_PORT = 4322;

function isPortInUse(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.createConnection({ port, host: "localhost" });
		socket.setTimeout(1000);
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => {
			socket.destroy();
			resolve(false);
		});
		socket.once("timeout", () => {
			socket.destroy();
			resolve(false);
		});
	});
}

const devServerRunning = await isPortInUse(DEV_PORT);
const port = devServerRunning ? DEV_PORT : FALLBACK_PORT;

export default defineConfig({
	testDir: "./tests/smoke",
	testMatch: "**/*.smoke.spec.ts",
	workers: 1,
	// Vite dev-server dep optimization can cause flaky first-run failures
	retries: 1,
	use: {
		baseURL: `http://localhost:${port}`,
		trace: "retain-on-failure",
		browserName: "chromium",
	},
	webServer: devServerRunning
		? undefined
		: {
				command: `MODE=test npm run dev -- --port ${FALLBACK_PORT}`,
				url: `http://localhost:${FALLBACK_PORT}/`,
				timeout: 120 * 1000,
				reuseExistingServer: true,
			},
});
