import { describe, expect, it } from "vitest";
import { createSaveSequencer } from "../../../src/lib/forms/save-sequencer";

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

// These tests stand in for the rapid-toggle race: a slow in-flight save must
// never overwrite a newer one, no matter the response order.
describe("createSaveSequencer — last write wins", () => {
	it("applies the result when nothing supersedes it", async () => {
		const seq = createSaveSequencer();
		const result = await seq.run(async () => "ok");
		expect(result).toEqual({ status: "applied", value: "ok" });
	});

	it("discards a stale response that resolves after a newer save", async () => {
		const seq = createSaveSequencer();
		const first = deferred<string>();
		const second = deferred<string>();

		const p1 = seq.run(() => first.promise); // save 1 (older)
		const p2 = seq.run(() => second.promise); // save 2 (newer) supersedes 1

		second.resolve("v2"); // newer resolves first...
		first.resolve("v1"); // ...older resolves last (out of order)

		expect(await p2).toEqual({ status: "applied", value: "v2" });
		expect(await p1).toEqual({ status: "stale" }); // older result discarded
	});

	it("aborts the prior in-flight save's signal when a newer save starts", async () => {
		const seq = createSaveSequencer();
		let firstSignal: AbortSignal | undefined;
		const first = deferred<string>();

		const p1 = seq.run((signal) => {
			firstSignal = signal;
			return first.promise;
		});
		expect(firstSignal?.aborted).toBe(false);

		const p2 = seq.run(async () => "v2");
		expect(firstSignal?.aborted).toBe(true); // superseded save was aborted

		// The aborted fetch rejects with an AbortError; it is reported stale.
		first.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
		expect(await p1).toEqual({ status: "stale" });
		expect(await p2).toEqual({ status: "applied", value: "v2" });
	});

	it("propagates a genuine failure from the latest save so it can be surfaced", async () => {
		const seq = createSaveSequencer();
		await expect(
			seq.run(async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
	});

	it("swallows a late failure from a superseded save as stale, not an error", async () => {
		const seq = createSaveSequencer();
		const first = deferred<string>();
		const p1 = seq.run(() => first.promise);
		const p2 = seq.run(async () => "v2");
		first.reject(new Error("late failure of stale request"));
		expect(await p2).toEqual({ status: "applied", value: "v2" });
		expect(await p1).toEqual({ status: "stale" });
	});

	it("supersede() aborts an in-flight save and marks its response stale", async () => {
		const seq = createSaveSequencer();
		let inFlightSignal: AbortSignal | undefined;
		const inFlight = deferred<string>();

		// A dropdown save is in flight when a sibling path (e.g. the mismatch
		// banner) persists the value itself and supersedes the in-flight save.
		const p1 = seq.run((signal) => {
			inFlightSignal = signal;
			return inFlight.promise;
		});
		expect(inFlightSignal?.aborted).toBe(false);

		seq.supersede();
		expect(inFlightSignal?.aborted).toBe(true); // in-flight save was aborted

		inFlight.resolve("late"); // even a successful late resolve is dropped
		expect(await p1).toEqual({ status: "stale" });
	});

	it("supersede() does not strand the next save — it still applies", async () => {
		const seq = createSaveSequencer();
		seq.supersede(); // claim latest with nothing in flight (safe no-op abort)
		const result = await seq.run(async () => "next");
		expect(result).toEqual({ status: "applied", value: "next" });
	});
});
