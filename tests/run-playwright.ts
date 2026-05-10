#!/usr/bin/env npx tsx
import { spawnSync } from "node:child_process";
import { acquireTestLock, formatContentionMessage, TestLockHeldError } from "./lock";

function main() {
	try {
		acquireTestLock("playwright");
	} catch (err) {
		if (err instanceof TestLockHeldError) {
			process.stderr.write(formatContentionMessage(err));
			process.exit(1);
		}
		throw err;
	}

	const child = spawnSync("./node_modules/.bin/playwright", ["test", ...process.argv.slice(2)], {
		stdio: "inherit",
		env: process.env,
		shell: process.platform === "win32",
	});

	process.exit(typeof child.status === "number" ? child.status : 1);
}

main();
