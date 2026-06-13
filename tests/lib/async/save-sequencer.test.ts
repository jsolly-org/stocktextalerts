import { describe, expect, it } from "vitest";
import { createSaveSequencer } from "../../../src/lib/async/save-sequencer";

/** Resolve-on-command deferred for ordering control. */
function deferred<T>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("createSaveSequencer", () => {
	it("applies a lone request's result", async () => {
		const seq = createSaveSequencer();
		const result = await seq.run(async () => "ok");
		expect(result).toEqual({ status: "applied", value: "ok" });
	});

	it("drops an out-of-order (superseded) response — older resolves last", async () => {
		const seq = createSaveSequencer();
		const first = deferred<string>();
		const second = deferred<string>();

		const p1 = seq.run(() => first.promise); // request 1 (older)
		const p2 = seq.run(() => second.promise); // request 2 (newer) supersedes 1

		second.resolve("v2"); // newer resolves first...
		first.resolve("v1"); // ...older resolves last (out of order)

		expect(await p2).toEqual({ status: "applied", value: "v2" });
		expect(await p1).toEqual({ status: "superseded" }); // older result discarded
	});

	it("aborts the prior in-flight request's signal when a newer run starts", async () => {
		const seq = createSaveSequencer();
		let firstSignal: AbortSignal | undefined;
		const first = deferred<string>();

		const p1 = seq.run((signal) => {
			firstSignal = signal;
			return first.promise;
		});
		expect(firstSignal?.aborted).toBe(false);

		const p2 = seq.run(async () => "v2");
		expect(firstSignal?.aborted).toBe(true); // superseded request was aborted

		first.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
		expect(await p1).toEqual({ status: "aborted" });
		expect(await p2).toEqual({ status: "applied", value: "v2" });
	});

	it("reports a genuine error from the latest request (not superseded/aborted)", async () => {
		const seq = createSaveSequencer();
		await expect(
			seq.run(async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
	});

	it("swallows a thrown error from a superseded request as 'superseded'", async () => {
		const seq = createSaveSequencer();
		const first = deferred<string>();
		const p1 = seq.run(() => first.promise);
		const p2 = seq.run(async () => "v2");
		first.reject(new Error("late failure of stale request"));
		expect(await p2).toEqual({ status: "applied", value: "v2" });
		expect(await p1).toEqual({ status: "superseded" });
	});
});
