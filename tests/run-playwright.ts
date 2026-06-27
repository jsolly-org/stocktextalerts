#!/usr/bin/env npx tsx
import { spawnSync } from "node:child_process";
import {
	acquireTestLockWithRetry,
	formatContentionMessage,
	releaseTestLock,
	TestLockHeldError,
} from "./lock";

async function main() {
	try {
		await acquireTestLockWithRetry("playwright");
	} catch (err) {
		if (err instanceof TestLockHeldError) {
			process.stderr.write(formatContentionMessage(err));
			process.exit(1);
		}
		throw err;
	}

	let exitCode = 1;
	try {
		const child = spawnSync("./node_modules/.bin/playwright", ["test", ...process.argv.slice(2)], {
			stdio: "inherit",
			env: process.env,
			shell: process.platform === "win32",
		});
		exitCode = typeof child.status === "number" ? child.status : 1;
	} finally {
		releaseTestLock();
	}

	process.exit(exitCode);
}

main().catch((err) => {
	process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
	process.exit(1);
});
