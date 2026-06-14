# Toggle State Desync Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or superpowers:subagent-driven-development) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. TDD: write the failing test/repro first.

**Goal:** Stop settings toggles from visibly flipping back to a stale value when the user toggles quickly. The cause is stale/out-of-order server responses clobbering newer user intent in optimistic-UI auto-save. Fix it at the root with a shared client-side request sequencer (monotonic seq + AbortController + apply-only-if-latest), applied to both auto-save paths.

**Architecture:** Push correctness into a single framework-agnostic primitive — `createSaveSequencer` — that both toggle paths consume. The primitive guarantees *last-write-wins by request order*: every save gets a monotonic token, the prior in-flight request is aborted, and a response mutates UI state **only if its token is still the latest**. Superseded and aborted responses are dropped silently. This makes the toggle's optimistic value authoritative until the latest save confirms, so an older response can never overwrite newer intent. No server-side concurrency control is added (see "Server-side: explicitly out of scope" below).

**Tech Stack:** Astro 5 SSR, Vue 3 (Composition API), TypeScript, Vitest (Node env — no jsdom), Playwright E2E (`page.route` interception), Biome.

---

## Spec (source: in-conversation investigation + /deep-research, 2026-06-13)

### Symptom
Rapidly toggling a setting on/off sometimes makes the toggle visibly flip back to a stale value before settling.

### Root causes (two confirmed sites)

1. **Notification panels — `pendingSave` clobber.** `useAutoSaveFormBase` ([src/components/dashboard/composables/useAutoSaveFormBase.ts](../../src/components/dashboard/composables/useAutoSaveFormBase.ts)) serializes saves with an `isSaving`/`pendingSave` flag. When the user toggles ON (request 1 fires, in-flight) then OFF before it returns, the OFF change is *queued* (`pendingSave = true`, [:170-173](../../src/components/dashboard/composables/useAutoSaveFormBase.ts:170)) — but **request 1's response still merges the now-stale value back into the shared `user.value`** via the panel's `savedData` watcher (e.g. [NotificationChannelsPanel.vue:283-293](../../src/components/dashboard/notification-channels/NotificationChannelsPanel.vue:283)) at [useAutoSaveFormBase.ts:134](../../src/components/dashboard/composables/useAutoSaveFormBase.ts:134). The UI flips to the stale value, then the queued save re-sends and corrects it — a visible flip. There is no sequence guard discarding the superseded response.

2. **TimeFormatSection — unguarded overlapping fetches + blind revert.** [TimeFormatSection.vue:75-122](../../src/components/profile/TimeFormatSection.vue:75) fires a `fetch` on every `watch` tick with no debounce, no abort, no sequencing — rapid flips spawn N overlapping requests with out-of-order responses. Worse, revert-on-error ([:99](../../src/components/profile/TimeFormatSection.vue:99), [:116](../../src/components/profile/TimeFormatSection.vue:116)) flips `!use24HourTime.value` based on *current* state, not the failed request's state, so a late failure can flip to the wrong value.

### Canonical fix (confirmed by research: MDN AbortController/AbortSignal, TanStack Query optimistic-update docs, Sébastien Lorber's "Handling API request race conditions in React", jsmanifest race-conditions)

- **Monotonic request-ID / sequence guard is load-bearing.** Tag each save with an incrementing token; apply a response only if its token is still latest. Works regardless of network reordering. *Debouncing alone cannot fix out-of-order responses — it only reduces frequency.*
- **AbortController is a complement, not a substitute.** Abort the superseded request so it usually never resolves — but abort is async and downstream code still runs, so the seq guard is still required.
- **Reconcile, don't clobber.** Apply the server response only when it is the latest (no newer mutation started). The toggle's optimistic value is authoritative meanwhile.
- **Toggle stays fully interactive** (user decision): no disable-during-flight. Remove the existing `:disabled="isSaving"` on TimeFormatSection. The sequencer handles rapid flips.

### Server-side: explicitly out of scope (and why)
ETag/`If-Match`, version columns, and idempotency keys are **not** needed here. A user editing their own settings is effectively single-writer, the writes are idempotent ("set value to X"), and last-write-wins *is* the desired semantic. Those mechanisms solve *multi-client concurrent-edit conflict detection*, which is not the failure mode. Same-user-two-devices is a real but low-value edge; deferred. Idempotency keys matter for non-idempotent writes (charge, send SMS), not toggles.

### Known residual (documented, not fixed here)
The notification panels (`NotificationChannelsPanel`, `DailyNotificationsPanel`, `AssetEventsPanel`, `MarketNotificationsPanel`) all POST to `/api/notification-preferences/update` and each merges a curated slice of the full snapshot. The *overlap* is server-derived scheduling fields (`daily_digest_time`, `*_next_send_at`). A stale cross-panel response could momentarily show an out-of-date **countdown** (not a toggle). The per-composable seq guard narrows but does not fully coordinate cross-panel ordering of these derived fields. This is a lesser, separate issue (countdown freshness, not toggle desync); noted in Task 5 notes with a follow-up option.

### Acceptance
- A Playwright E2E repro that **reorders responses** (delays request 1 past request 2) drives the toggle flip on `main` and passes after the fix.
- `createSaveSequencer` has Vitest unit tests pinning applied/superseded/aborted semantics.
- `npm run check:biome`, `npm run check:ts`, `npm run check:knip`, `npm test`, `npm run build` all pass.
- No server/migration changes; `EXPECTED_DB_SCHEMA_VERSION` untouched.

---

## File Structure

| File | Responsibility | Tasks |
| --- | --- | --- |
| `src/lib/async/save-sequencer.ts` (new) | Framework-free seq + abort primitive | 1 |
| `tests/lib/async/save-sequencer.test.ts` (new) | Unit tests (Node, no DOM) | 1 |
| `src/components/dashboard/composables/useAutoSaveFormBase.ts` | Consume sequencer; drop `pendingSave`; apply-if-latest; combine abort+timeout | 2 |
| `src/components/profile/TimeFormatSection.vue` | Consume sequencer; intended/confirmed reconcile; remove `isReverting` hack + `:disabled` | 3 |
| `tests/e2e/profile-settings.e2e.spec.ts` (extend) | Reordered-response repro for the time toggle | 4 |
| `tests/e2e/delivery-times.e2e.spec.ts` or new `notification-toggle.e2e.spec.ts` | Reordered-response repro for a notification toggle | 4 |

> Confirm exact E2E file to extend with `grep -ln "time-format\|Use 24-hour\|use_24_hour_time" tests/e2e/*.ts` before Task 4; the time-format toggle test most likely lives in `profile-settings.e2e.spec.ts`.

---

## Task 1: `createSaveSequencer` primitive + unit tests

**Files:**
- Create: `src/lib/async/save-sequencer.ts`
- Create: `tests/lib/async/save-sequencer.test.ts`

- [ ] **Step 1: Write the failing tests first**

`tests/lib/async/save-sequencer.test.ts` (Vitest, Node env — uses only Promises + AbortController, no DOM):

```ts
import { describe, expect, it, vi } from "vitest";
import { createSaveSequencer } from "../../src/lib/async/save-sequencer";

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
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/lib/async/save-sequencer.test.ts`
Expected: FAIL — module does not exist yet.

- [ ] **Step 3: Implement the primitive**

`src/lib/async/save-sequencer.ts`:

```ts
/**
 * Result of a sequenced save attempt.
 * - `applied`    — this was still the latest request when it resolved; caller should commit `value`.
 * - `superseded` — a newer request started before this one resolved; caller must drop the result.
 * - `aborted`    — this request's signal was aborted (because a newer request superseded it).
 */
export type SequencedResult<T> =
  | { status: "applied"; value: T }
  | { status: "superseded" }
  | { status: "aborted" };

/**
 * Serializes "last write wins" for idempotent saves.
 *
 * Each `run` gets a monotonic token and a fresh AbortSignal; starting a new
 * `run` aborts the previous one. A task's result is only `applied` if its token
 * is still the latest when it resolves, so an out-of-order/stale response can
 * never clobber newer user intent. Aborting is a best-effort complement: because
 * abort is async and downstream work may still run, the token check — not the
 * abort — is the actual correctness guarantee.
 */
export function createSaveSequencer() {
  let latest = 0;
  let activeController: AbortController | null = null;

  async function run<T>(
    task: (signal: AbortSignal) => Promise<T>,
  ): Promise<SequencedResult<T>> {
    const token = ++latest;
    // Supersede any in-flight request.
    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;

    try {
      const value = await task(controller.signal);
      if (token !== latest) return { status: "superseded" };
      return { status: "applied", value };
    } catch (error) {
      if (controller.signal.aborted) return { status: "aborted" };
      // A stale request that failed on its own (not via abort) is still stale.
      if (token !== latest) return { status: "superseded" };
      throw error;
    } finally {
      if (activeController === controller) activeController = null;
    }
  }

  return { run };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- tests/lib/async/save-sequencer.test.ts && npm run check:ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/async/save-sequencer.ts tests/lib/async/save-sequencer.test.ts
git commit -m "feat(async): createSaveSequencer — last-write-wins request guard

Implements docs/plans/2026-06-13-toggle-state-desync.md (Task 1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Integrate the sequencer into `useAutoSaveFormBase`

**Files:**
- Modify: `src/components/dashboard/composables/useAutoSaveFormBase.ts`

**Approach:** Wrap the fetch in `sequencer.run`. Apply state (`savedData`, `lastSavedSignature`, `setStatus(null)`) **only** on `status === "applied"`. Drop the `isSaving`/`pendingSave` serialization entirely — with the sequencer, a newer save simply supersedes the in-flight one; the existing 450ms debounce already coalesces rapid input, and the trailing change is re-sent through the debounce path. `isSaving` remains *only* for the "Saving…" badge and is cleared only by the latest request.

- [ ] **Step 1: Add the sequencer and rework `sendUpdate`**

At the top of `useAutoSaveFormBase`, after the refs:

```ts
import { createSaveSequencer } from "../../lib/async/save-sequencer";
// ...
const sequencer = createSaveSequencer();
```

Replace `sendUpdate` ([:97-159](../../src/components/dashboard/composables/useAutoSaveFormBase.ts:97)) with a version that runs through the sequencer, combines the supersede-abort signal with the existing 10s timeout via `AbortSignal.any`, and commits only when latest:

```ts
async function sendUpdate(form: HTMLFormElement, formData: FormData, submittedSignature: string) {
  isSaving.value = true;

  // Only show "Saving…" if the request takes longer than 200 ms.
  const savingIndicatorHandle = window.setTimeout(() => {
    setStatus("Saving...", "info");
  }, 200);

  const outcome = await sequencer.run(async (supersedeSignal) => {
    const response = await fetch(form.action, {
      method: "POST",
      body: formData,
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      // Abort when superseded by a newer save OR after the 10s timeout.
      signal: AbortSignal.any([supersedeSignal, AbortSignal.timeout(10_000)]),
    });

    if (isUnauthorizedResponse(response)) {
      redirectToSignIn();
      return { kind: "unauthorized" as const };
    }
    const payload = (await response.json()) as FormSaveResponse;
    return { kind: "json" as const, ok: response.ok, payload };
  });

  window.clearTimeout(savingIndicatorHandle);

  // Superseded/aborted: a newer save is authoritative — drop this response,
  // and do NOT clear isSaving (the newer save owns it).
  if (outcome.status !== "applied") {
    return;
  }

  isSaving.value = false;
  const result = outcome.value;
  if (result.kind === "unauthorized") return;

  const { ok, payload } = result;
  if (!ok || !payload.ok) {
    const formattedMessage =
      payload && typeof payload.message === "string" ? formatMessage(payload.message) : "";
    setStatus(formattedMessage || "Could not save changes. Please try again.", "error");
    return;
  }

  lastSavedSignature.value = submittedSignature;
  setStatus(null);
  const payloadData = payload[options.payloadKey] as T | undefined;
  savedData.value = payloadData ?? null;
}
```

Handle the latest-request error path: the `sequencer.run` task only throws for the *latest* request (superseded throws are swallowed to `superseded`). Wrap the `await sequencer.run(...)` in try/catch to keep the existing timeout/`request_failed` logging and status, e.g.:

```ts
let outcome;
try {
  outcome = await sequencer.run(async (supersedeSignal) => { /* ...as above... */ });
} catch (error) {
  window.clearTimeout(savingIndicatorHandle);
  isSaving.value = false;
  const reason =
    error instanceof Error && error.name === "TimeoutError" ? "timeout" : "request_failed";
  setStatus(
    reason === "timeout" ? "Save timed out. Please try again." : "Could not save changes. Please try again.",
    "error",
  );
  rootLogger.error("Autosave failed for dashboard form", { action: options.logAction, reason }, error);
  return;
}
```

(Restructure so `savingIndicatorHandle` is cleared in both the catch and the normal path — a single `try/finally` around the whole body that clears the handle is cleanest. Match the existing logger call shape at [:143-147](../../src/components/dashboard/composables/useAutoSaveFormBase.ts:143).)

- [ ] **Step 2: Remove `pendingSave` and the `isSaving` gate in `triggerSave`**

Delete the `let pendingSave = false;` declaration ([:80](../../src/components/dashboard/composables/useAutoSaveFormBase.ts:80)) and the `if (pendingSave) { ... }` re-trigger block in the old `finally` ([:151-157](../../src/components/dashboard/composables/useAutoSaveFormBase.ts:151)).

Change `triggerSave` ([:164-176](../../src/components/dashboard/composables/useAutoSaveFormBase.ts:164)) so it no longer bails while saving — let the new save supersede the in-flight one:

```ts
async function triggerSave(form: HTMLFormElement) {
  const formData = new FormData(form);
  const currentSignature = serializeFormData(formData);
  if (currentSignature === lastSavedSignature.value) {
    return;
  }
  await sendUpdate(form, formData, currentSignature);
}
```

- [ ] **Step 3: Type-check + lint + full unit suite**

Run: `npm run check:ts && npm run check:biome && npm run check:knip`
Expected: PASS. `knip` should not flag `createSaveSequencer` as unused (it's imported here). Fix any leftover unused symbols from the `pendingSave` removal.

Run: `npm test`
Expected: PASS (no existing unit test mounts this composable; confirm none broke).

- [ ] **Step 4: Commit**

```bash
git add src/components/dashboard/composables/useAutoSaveFormBase.ts
git commit -m "fix(dashboard): sequence auto-save so stale responses don't flip toggles

Drop pendingSave serialization; apply server response only when it is the
latest in-flight save, aborting superseded requests. Fixes the visible
toggle flip-back on rapid toggling.

Implements docs/plans/2026-06-13-toggle-state-desync.md (Task 2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Refactor `TimeFormatSection` onto the sequencer

**Files:**
- Modify: `src/components/profile/TimeFormatSection.vue`

**Approach:** Track `confirmedValue` (last server-acked value, init from props). On user toggle: optimistic flip, then `sequencer.run(fetch)`. On `applied + ok` → `confirmedValue = sent value`. On `applied + error` → revert the toggle to `confirmedValue` (the last known-good), show error. On `superseded`/`aborted` → do nothing (a newer toggle owns the truth). Remove the `isReverting`/`nextTick` hack and the `:disabled="isSaving"` (user decision: stay interactive). A single `applyingProgrammaticValue` guard prevents the revert's programmatic write from re-triggering the watch.

- [ ] **Step 1: Write the failing E2E repro** — deferred to Task 4 (this is a Vue SFC; no Node-unit harness exists). Implement Step 2 against the Task 4 repro.

- [ ] **Step 2: Rewrite the `<script setup>` state + save**

Replace [:69-122](../../src/components/profile/TimeFormatSection.vue:69):

```ts
import { ref, watch } from "vue";
import { createSaveSequencer } from "../../lib/async/save-sequencer";
// ...existing imports (drop nextTick)...

const use24HourTime = ref(props.user.use_24_hour_time ?? false);
let confirmedValue = props.user.use_24_hour_time ?? false; // last server-acked value
let applyingProgrammaticValue = false; // suppress watch during revert
const isSaving = ref(false);
const statusMessage = ref<string | null>(null);
const statusTone = ref<"success" | "error">("success");

const sequencer = createSaveSequencer();

watch(use24HourTime, () => {
  if (applyingProgrammaticValue) return;
  void saveTimeFormat();
});

async function saveTimeFormat() {
  const intended = use24HourTime.value;
  isSaving.value = true;
  statusMessage.value = null;

  let outcome;
  try {
    outcome = await sequencer.run(async (signal) => {
      const formData = new FormData();
      formData.set("use_24_hour_time", intended ? "on" : "off");
      const response = await fetch("/api/profile/time-format", {
        method: "POST",
        body: formData,
        signal,
      });
      const data = await response.json();
      return { ok: response.ok && data.ok };
    });
  } catch (error) {
    rootLogger.error("Failed to update time format from profile", { action: "update_time_format" }, error);
    revertTo(confirmedValue, "Failed to update time format. Please try again.");
    isSaving.value = false;
    return;
  }

  // A newer toggle superseded this save — it owns the final state; do nothing.
  if (outcome.status !== "applied") return;

  isSaving.value = false;
  if (outcome.value.ok) {
    confirmedValue = intended;
    statusMessage.value = "Time format updated.";
    statusTone.value = "success";
  } else {
    revertTo(confirmedValue, "Failed to update time format. Please try again.");
  }
}

function revertTo(value: boolean, message: string) {
  applyingProgrammaticValue = true;
  use24HourTime.value = value;
  applyingProgrammaticValue = false;
  statusMessage.value = message;
  statusTone.value = "error";
}
```

- [ ] **Step 3: Remove `:disabled="isSaving"` from the toggle**

In the template, delete `:disabled="isSaving"` at [TimeFormatSection.vue:46](../../src/components/profile/TimeFormatSection.vue:46) so the toggle stays interactive during saves. (Keep `isSaving` only if still used for the status badge; if it becomes unused after this, drop the ref so `knip`/`check:ts` stays clean.)

- [ ] **Step 4: Type-check + lint**

Run: `npm run check:ts && npm run check:biome && npm run check:knip`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/profile/TimeFormatSection.vue
git commit -m "fix(profile): sequence the time-format toggle save

Replace per-tick overlapping fetches and blind revert with the shared
save-sequencer + intended/confirmed reconciliation. Toggle stays interactive.

Implements docs/plans/2026-06-13-toggle-state-desync.md (Task 3)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Playwright E2E repro — reordered responses

**Files:**
- Extend: `tests/e2e/profile-settings.e2e.spec.ts` (time-format toggle) — confirm with the grep above.
- Add: notification-toggle reorder test (extend `tests/e2e/delivery-times.e2e.spec.ts` or create `tests/e2e/notification-toggle.e2e.spec.ts`), modeled on the `page.route` usage already in `tests/e2e/routes.e2e.spec.ts` / `delivery-times.e2e.spec.ts`.

**Why E2E:** Vitest runs in Node with no DOM/Vue harness, so the out-of-order race can only be reproduced with a real browser. Playwright `page.route` can hold request 1 open and let request 2 fulfill first — deterministically reproducing the stale-response clobber.

- [ ] **Step 1: Write the failing repro (time-format toggle)**

Use a route handler that **delays the first POST** to `/api/profile/time-format` longer than the second, forcing out-of-order resolution. Sketch:

```ts
test("rapid time-format toggling does not flip back to a stale value", async ({ page }) => {
  // ...sign in + navigate to profile (reuse existing helpers in this spec)...

  let call = 0;
  await page.route("**/api/profile/time-format", async (route) => {
    call += 1;
    const thisCall = call;
    // Delay the FIRST response so it resolves AFTER the second (out of order).
    await new Promise((r) => setTimeout(r, thisCall === 1 ? 800 : 100));
    await route.continue();
  });

  const toggle = page.getByRole("switch", { name: "Use 24-hour time" });
  // Rapid ON then OFF — final intent is OFF (assuming it starts OFF→ON→OFF).
  await toggle.click(); // -> ON  (request 1, delayed 800ms)
  await toggle.click(); // -> OFF (request 2, delayed 100ms, resolves first)

  // Wait for both responses to settle.
  await page.waitForTimeout(1200);

  // The toggle must reflect the user's LAST intent (OFF), not request 1's stale ON.
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  // And the persisted value matches (read back via API or DB helper used in this spec).
});
```

Adjust selector/`aria` attributes to `ToggleSwitch.vue`'s actual ARIA (it's a `button`-based switch — verify `role`/`aria-checked` or `aria-pressed`). Confirm the exact toggle accessible name from the component.

- [ ] **Step 2: Run on the fix branch**

Run: `npm run test:e2e -- tests/e2e/profile-settings.e2e.spec.ts` (needs Playwright + Supabase + dev on 4322; see AGENTS.md). 
Expected after Tasks 1+3: PASS. To prove it's a real repro, `git stash` the Task 3 change and rerun — expected FAIL (toggle flips to stale ON). Then restore.

- [ ] **Step 3: Add the notification-toggle reorder test**

Same pattern against `**/api/notification-preferences/update`, toggling an SMS/email channel switch in the notification-channels panel rapidly, asserting the toggle (and `user.value`-driven UI) lands on the last intent. Confirm it FAILS with Task 2 stashed and PASSES with it applied.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/
git commit -m "test(e2e): reordered-response repro for rapid toggle desync

Implements docs/plans/2026-06-13-toggle-state-desync.md (Task 4)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Final verification

- [ ] `npm run check:biome` — clean
- [ ] `npm run check:ts` — clean
- [ ] `npm run check:knip` — no new unused exports (`pendingSave` removal, `nextTick`/`isReverting` removal)
- [ ] `npm test` — full unit suite green (includes `save-sequencer.test.ts`)
- [ ] `npm run test:e2e -- tests/e2e/profile-settings.e2e.spec.ts <notification-toggle spec>` — both reorder repros green
- [ ] `npm run build` — succeeds
- [ ] Manual check: in the browser with network throttled (DevTools "Slow 3G"), rapidly toggle the time-format switch and an SMS channel switch; confirm no visible flip-back and the final state persists after refresh.
- [ ] No migration created; `EXPECTED_DB_SCHEMA_VERSION` unchanged.

## Notes / risks

- **Last-write-wins is intentional and correct here.** Aborting request 1 after the server may have already committed its write is fine — request 2 carries the final intent and overwrites idempotently. No data loss for idempotent settings.
- **`AbortSignal.any` baseline:** available in Node 24 and all modern browsers (matches the project's modern-web-baseline rule; the code already uses `AbortSignal.timeout`). No polyfill.
- **Cross-panel scheduling-field residual (documented above):** if a stale countdown is ever reported, the follow-up is a per-field "don't overwrite if a newer change to this field is pending" guard, or routing all four panels' saves to the same endpoint through one shared sequencer keyed per-field (NOT per-endpoint — a per-endpoint sequencer would wrongly abort concurrent writes to *different* fields). Out of scope for the toggle-flip fix.
- **No server changes.** If same-user-multi-device conflict ever becomes a real requirement, revisit with `If-Match`/version columns — but that is a different problem than this bug.
```
