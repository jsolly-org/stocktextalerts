import net from "node:net";
import { defineConfig } from "@playwright/test";
import { sharedDefaults } from "./playwright.shared";

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
	...sharedDefaults,
	testDir: "./tests/smoke",
	testMatch: "**/*.smoke.spec.ts",
	// Vite dev-server dep optimization can cause flaky first-run failures
	retries: 1,
	use: {
		...sharedDefaults.use,
		baseURL: `http://localhost:${port}`,
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
