import { execFileSync } from "node:child_process";
import path from "node:path";

export type TestLockCommand = "vitest" | "playwright";

export interface TestLockPayload {
	pid: number;
	worktreePath: string;
	command: TestLockCommand;
	startedAt: string;
}

export class TestLockHeldError extends Error {
	readonly holder: TestLockPayload;

	constructor(holder: TestLockPayload) {
		super(`Test lock already held by PID ${holder.pid} (${holder.command})`);
		this.name = "TestLockHeldError";
		this.holder = holder;
	}
}

let cachedLockPath: string | null = null;

export function getLockPath(): string {
	if (cachedLockPath !== null) return cachedLockPath;

	const raw = execFileSync("git", ["rev-parse", "--git-common-dir"], {
		cwd: process.cwd(),
		encoding: "utf8",
	}).trim();
	cachedLockPath = path.join(path.resolve(process.cwd(), raw), "test.lock");
	return cachedLockPath;
}
