import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// "reset" is held by `db:reset` (scripts/db/reset.ts) so a destructive reseed of the
// shared local stack can't run while another worktree's vitest/playwright suite is reading it.
// The lock is keyed on `git rev-parse --git-common-dir`, so it's shared across all worktrees.
export type TestLockCommand = "vitest" | "playwright" | "reset";

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

function isProcessAlive(pid: number): boolean {
	// PID 0 sends to the current process group on POSIX and -1 broadcasts —
	// neither is a valid lock-holder PID. Without this guard, a corrupt lock
	// file containing pid:0 / pid:-1 / pid:null / pid:NaN would be treated
	// as "alive" and permanently block acquisition.
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		// EPERM means the process exists but is owned by another user.
		if (code === "EPERM") return true;
		if (code === "ESRCH") return false;
		throw err;
	}
}

let handlersRegistered = false;
let activeLockPath: string | null = null;

function registerHandlersOnce(lockPath: string): void {
	activeLockPath = lockPath;
	if (handlersRegistered) return;
	handlersRegistered = true;

	process.on("exit", () => {
		if (activeLockPath !== null) releaseTestLock(activeLockPath);
	});
	process.on("SIGINT", () => {
		if (activeLockPath !== null) releaseTestLock(activeLockPath);
		process.exit(130);
	});
	process.on("SIGTERM", () => {
		if (activeLockPath !== null) releaseTestLock(activeLockPath);
		process.exit(143);
	});
	process.on("uncaughtException", (err) => {
		if (activeLockPath !== null) releaseTestLock(activeLockPath);
		// Re-throwing inside an `uncaughtException` handler re-emits the same
		// event (per Node docs) and loops. Print the original error and exit
		// non-zero so the developer still sees what happened.
		process.stderr.write(
			`uncaughtException after lock acquire: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
		);
		process.exit(1);
	});
}

export function acquireTestLock(command: TestLockCommand, lockPath: string = getLockPath()): void {
	if (activeLockPath !== null) {
		throw new Error(
			`acquireTestLock: already holding ${activeLockPath}. Release before re-acquiring.`,
		);
	}

	const payload: TestLockPayload = {
		pid: process.pid,
		worktreePath: process.cwd(),
		command,
		startedAt: new Date().toISOString(),
	};

	try {
		fs.writeFileSync(lockPath, JSON.stringify(payload), { flag: "wx" });
		registerHandlersOnce(lockPath);
		return;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
	}

	let holder: TestLockPayload | null = null;
	try {
		holder = JSON.parse(fs.readFileSync(lockPath, "utf8")) as TestLockPayload;
	} catch {
		// Unparseable — treat as stale below.
	}

	if (holder !== null && isProcessAlive(holder.pid)) {
		throw new TestLockHeldError(holder);
	}

	if (holder !== null) {
		const ageMs = Date.now() - Date.parse(holder.startedAt);
		const ageMin = Number.isFinite(ageMs) ? Math.max(1, Math.round(ageMs / 60_000)) : null;
		const worktreeName = path.basename(holder.worktreePath);
		const ageSuffix = ageMin === null ? "started ?m ago" : `started ${ageMin}m ago`;
		process.stderr.write(
			`test-lock: stale lock from PID ${holder.pid} (worktree: ${worktreeName}, command: ${holder.command}, ${ageSuffix}) — taking over\n`,
		);
	} else {
		process.stderr.write("test-lock: stale (corrupt) lock — taking over\n");
	}

	fs.writeFileSync(lockPath, JSON.stringify(payload), { flag: "w" });
	registerHandlersOnce(lockPath);
}

export function releaseTestLock(lockPath: string = getLockPath()): void {
	let raw: string;
	try {
		raw = fs.readFileSync(lockPath, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			if (activeLockPath === lockPath) activeLockPath = null;
			return;
		}
		throw err;
	}

	let parsed: TestLockPayload;
	try {
		parsed = JSON.parse(raw) as TestLockPayload;
	} catch {
		return;
	}

	if (parsed.pid !== process.pid) return;

	try {
		fs.unlinkSync(lockPath);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	if (activeLockPath === lockPath) activeLockPath = null;
}

const RED = "\x1b[0;31m";
const RESET = "\x1b[0m";

/** Format the contention banner shown when another worktree holds the lock. */
const DEFAULT_LOCK_RETRY_WAIT_MS = 120_000;
const DEFAULT_LOCK_RETRY_MAX_ATTEMPTS = 3;

interface AcquireTestLockRetryOptions {
	waitMs?: number;
	maxAttempts?: number;
}

/** Banner printed before each wait when the lock is still held. */
function formatWaitingMessage(
	err: TestLockHeldError,
	attempt: number,
	maxAttempts: number,
	waitMs: number,
): string {
	const waitMin = Math.round(waitMs / 60_000);
	return (
		`test-lock: still held by PID ${err.holder.pid} (${err.holder.command}) ` +
		`in ${err.holder.worktreePath} — ` +
		`waiting ${waitMin}m before retry (${attempt}/${maxAttempts})\n`
	);
}

/**
 * Acquire the cross-worktree test lock, waiting between attempts when another
 * worktree holds it. Used by `npm test` / `npm run test:e2e` so agents (and
 * humans) don't fail immediately during concurrent runs.
 */
export async function acquireTestLockWithRetry(
	command: TestLockCommand,
	options: AcquireTestLockRetryOptions = {},
	lockPath: string = getLockPath(),
): Promise<void> {
	const waitMs = options.waitMs ?? DEFAULT_LOCK_RETRY_WAIT_MS;
	const maxAttempts = options.maxAttempts ?? DEFAULT_LOCK_RETRY_MAX_ATTEMPTS;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			acquireTestLock(command, lockPath);
			return;
		} catch (err) {
			if (!(err instanceof TestLockHeldError)) throw err;
			if (attempt >= maxAttempts) throw err;
			process.stderr.write(formatWaitingMessage(err, attempt, maxAttempts, waitMs));
			await new Promise((resolve) => setTimeout(resolve, waitMs));
		}
	}
}

export function formatContentionMessage(err: TestLockHeldError): string {
	const { pid, worktreePath, command, startedAt } = err.holder;
	const elapsedMs = Date.now() - Date.parse(startedAt);
	const elapsedMin = Number.isFinite(elapsedMs) ? Math.floor(elapsedMs / 60_000) : 0;
	const elapsedSec = Number.isFinite(elapsedMs) ? Math.floor((elapsedMs % 60_000) / 1000) : 0;
	const elapsed = `${elapsedMin}m ${elapsedSec.toString().padStart(2, "0")}s`;
	const lockPath = getLockPath();

	return (
		`\n${RED}✗ Tests are already running.${RESET}\n\n` +
		`  Holder:    ${worktreePath}\n` +
		`  Command:   ${command}\n` +
		`  PID:       ${pid}\n` +
		`  Running:   ${elapsed}\n\n` +
		`Wait for that run to finish, or:\n` +
		`  - Kill it:           kill ${pid}\n` +
		`  - Force-clear (only if you're sure it's dead):\n` +
		`                       rm ${lockPath}\n\n`
	);
}
