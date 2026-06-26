import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	acquireTestLock,
	acquireTestLockWithRetry,
	getLockPath,
	releaseTestLock,
	TestLockHeldError,
	type TestLockPayload,
} from "../lock";

function makeTempLockPath(): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), "test-lock-"));
	return path.join(dir, "test.lock");
}

describe("getLockPath", () => {
	it("returns an absolute path inside the git common directory, named test.lock", () => {
		const lockPath = getLockPath();
		expect(path.isAbsolute(lockPath)).toBe(true);
		expect(path.basename(lockPath)).toBe("test.lock");

		const expectedDir = path.resolve(
			process.cwd(),
			execFileSync("git", ["rev-parse", "--git-common-dir"], {
				cwd: process.cwd(),
				encoding: "utf8",
			}).trim(),
		);
		expect(path.dirname(lockPath)).toBe(expectedDir);
	});
});

describe("acquireTestLock — fresh acquire", () => {
	it("writes a payload with our PID, cwd, command, and a parseable startedAt", () => {
		const lockPath = makeTempLockPath();
		try {
			acquireTestLock("vitest", lockPath);
			const payload = JSON.parse(readFileSync(lockPath, "utf8")) as TestLockPayload;
			expect(payload.pid).toBe(process.pid);
			expect(payload.worktreePath).toBe(process.cwd());
			expect(payload.command).toBe("vitest");
			expect(Number.isFinite(Date.parse(payload.startedAt))).toBe(true);
		} finally {
			releaseTestLock(lockPath);
			rmSync(path.dirname(lockPath), { recursive: true, force: true });
		}
	});
});

describe("acquireTestLock — contention", () => {
	it("throws TestLockHeldError when an alive PID holds the lock", () => {
		const lockPath = makeTempLockPath();
		try {
			const holder: TestLockPayload = {
				pid: process.pid,
				worktreePath: "/some/other/worktree",
				command: "playwright",
				startedAt: new Date().toISOString(),
			};
			writeFileSync(lockPath, JSON.stringify(holder), { flag: "wx" });

			let captured: TestLockHeldError | null = null;
			try {
				acquireTestLock("vitest", lockPath);
			} catch (err) {
				if (err instanceof TestLockHeldError) {
					captured = err;
				} else {
					throw err;
				}
			}
			expect(captured).not.toBeNull();
			expect(captured?.holder.pid).toBe(process.pid);
			expect(captured?.holder.worktreePath).toBe("/some/other/worktree");
			expect(captured?.holder.command).toBe("playwright");
			expect(captured?.holder.startedAt).toBe(holder.startedAt);
		} finally {
			rmSync(path.dirname(lockPath), { recursive: true, force: true });
		}
	});
});

describe("acquireTestLock — stale takeover", () => {
	it("overwrites the lock when the holder PID is dead", () => {
		const lockPath = makeTempLockPath();
		// Use a PID structurally guaranteed to be dead. INT32_MAX is well past
		// pid_max on Linux (default 4_194_304) and macOS (~99_998), so
		// process.kill(pid, 0) reliably returns ESRCH. A spawnSync'd child PID
		// can be recycled by the kernel between exit and our liveness check
		// — the testing rule "remove nondeterminism" applies.
		const deadPid = 2_147_483_647;
		try {
			const stale: TestLockPayload = {
				pid: deadPid,
				worktreePath: "/old/worktree",
				command: "vitest",
				startedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
			};
			writeFileSync(lockPath, JSON.stringify(stale), { flag: "wx" });

			acquireTestLock("playwright", lockPath);

			const payload = JSON.parse(readFileSync(lockPath, "utf8")) as TestLockPayload;
			expect(payload.pid).toBe(process.pid);
			expect(payload.command).toBe("playwright");
		} finally {
			releaseTestLock(lockPath);
			rmSync(path.dirname(lockPath), { recursive: true, force: true });
		}
	});

	it("overwrites the lock when the file is corrupt", () => {
		const lockPath = makeTempLockPath();
		try {
			writeFileSync(lockPath, "not json", { flag: "wx" });

			acquireTestLock("vitest", lockPath);

			const payload = JSON.parse(readFileSync(lockPath, "utf8")) as TestLockPayload;
			expect(payload.pid).toBe(process.pid);
		} finally {
			releaseTestLock(lockPath);
			rmSync(path.dirname(lockPath), { recursive: true, force: true });
		}
	});
});

describe("releaseTestLock — defensive", () => {
	it("is a no-op when the file's PID does not match ours", () => {
		const lockPath = makeTempLockPath();
		try {
			const other: TestLockPayload = {
				pid: process.pid + 1,
				worktreePath: "/elsewhere",
				command: "vitest",
				startedAt: new Date().toISOString(),
			};
			writeFileSync(lockPath, JSON.stringify(other), { flag: "wx" });

			releaseTestLock(lockPath);

			expect(existsSync(lockPath)).toBe(true);
			const payload = JSON.parse(readFileSync(lockPath, "utf8")) as TestLockPayload;
			expect(payload.pid).toBe(process.pid + 1);
		} finally {
			rmSync(path.dirname(lockPath), { recursive: true, force: true });
		}
	});

	it("removes the lock file when our PID owns it", () => {
		const lockPath = makeTempLockPath();
		try {
			acquireTestLock("vitest", lockPath);
			expect(existsSync(lockPath)).toBe(true);
			releaseTestLock(lockPath);
			expect(existsSync(lockPath)).toBe(false);
		} finally {
			rmSync(path.dirname(lockPath), { recursive: true, force: true });
		}
	});
});

describe("acquireTestLockWithRetry", () => {
	it("acquires immediately when the lock is free", async () => {
		const lockPath = makeTempLockPath();
		try {
			await acquireTestLockWithRetry("vitest", { waitMs: 50, maxAttempts: 3 }, lockPath);
			const payload = JSON.parse(readFileSync(lockPath, "utf8")) as TestLockPayload;
			expect(payload.pid).toBe(process.pid);
		} finally {
			releaseTestLock(lockPath);
			rmSync(path.dirname(lockPath), { recursive: true, force: true });
		}
	});

	it("waits and retries until the holder releases the lock", async () => {
		const lockPath = makeTempLockPath();
		const lockModulePath = path.resolve(process.cwd(), "tests/lock.ts");
		const markerPath = `${lockPath}.child-ready`;

		const child = spawn(
			"./node_modules/.bin/tsx",
			[
				"-e",
				`import("${lockModulePath}").then(async ({ acquireTestLock, releaseTestLock }) => {
					acquireTestLock("playwright", ${JSON.stringify(lockPath)});
					require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "ok");
					await new Promise((r) => setTimeout(r, 180));
					releaseTestLock(${JSON.stringify(lockPath)});
				});`,
			],
			{ cwd: process.cwd() },
		);

		try {
			const start = Date.now();
			while (!existsSync(markerPath)) {
				if (Date.now() - start > 10_000) {
					throw new Error("child never acquired lock");
				}
				await new Promise((r) => setTimeout(r, 25));
			}

			await acquireTestLockWithRetry("vitest", { waitMs: 50, maxAttempts: 5 }, lockPath);

			const payload = JSON.parse(readFileSync(lockPath, "utf8")) as TestLockPayload;
			expect(payload.pid).toBe(process.pid);
			expect(payload.command).toBe("vitest");
		} finally {
			child.kill("SIGKILL");
			await new Promise<void>((resolve) => {
				child.on("exit", () => resolve());
			});
			releaseTestLock(lockPath);
			rmSync(path.dirname(lockPath), { recursive: true, force: true });
		}
	}, 10_000);

	it("throws TestLockHeldError after maxAttempts when the lock stays held", async () => {
		const lockPath = makeTempLockPath();
		const lockModulePath = path.resolve(process.cwd(), "tests/lock.ts");
		const markerPath = `${lockPath}.child-ready`;

		const child = spawn(
			"./node_modules/.bin/tsx",
			[
				"-e",
				`import("${lockModulePath}").then(({ acquireTestLock }) => {
					acquireTestLock("playwright", ${JSON.stringify(lockPath)});
					require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "ok");
					setInterval(() => {}, 1000);
				});`,
			],
			{ cwd: process.cwd() },
		);

		try {
			const start = Date.now();
			while (!existsSync(markerPath)) {
				if (Date.now() - start > 10_000) {
					throw new Error("child never acquired lock");
				}
				await new Promise((r) => setTimeout(r, 25));
			}

			await expect(
				acquireTestLockWithRetry("vitest", { waitMs: 20, maxAttempts: 2 }, lockPath),
			).rejects.toBeInstanceOf(TestLockHeldError);
		} finally {
			child.kill("SIGKILL");
			await new Promise<void>((resolve) => {
				child.on("exit", () => resolve());
			});
			rmSync(path.dirname(lockPath), { recursive: true, force: true });
		}
	}, 10_000);
});

describe("acquireTestLock — signal handlers", () => {
	it("releases the lock on SIGINT and exits 130", async () => {
		const lockPath = makeTempLockPath();
		const markerPath = `${lockPath}.acquired`;
		const lockModulePath = path.resolve(process.cwd(), "tests/lock.ts");

		try {
			const child = spawn(
				"./node_modules/.bin/tsx",
				[
					"-e",
					`import("${lockModulePath}").then(({ acquireTestLock }) => {
						acquireTestLock("vitest", ${JSON.stringify(lockPath)});
						require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "ok");
						setInterval(() => {}, 1000);
					});`,
				],
				{ cwd: process.cwd() },
			);

			const start = Date.now();
			while (!existsSync(markerPath)) {
				if (Date.now() - start > 10_000) {
					child.kill("SIGKILL");
					throw new Error("child never acquired lock");
				}
				await new Promise((r) => setTimeout(r, 25));
			}
			expect(existsSync(lockPath)).toBe(true);

			child.kill("SIGINT");

			const exitCode: number = await new Promise((resolve) => {
				child.on("exit", (code) => resolve(code ?? -1));
			});
			expect(exitCode).toBe(130);
			expect(existsSync(lockPath)).toBe(false);
		} finally {
			rmSync(path.dirname(lockPath), { recursive: true, force: true });
		}
	}, 15_000);
});
