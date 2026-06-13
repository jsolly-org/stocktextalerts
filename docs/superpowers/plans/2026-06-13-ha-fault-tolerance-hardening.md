# HA & Fault-Tolerance Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the specific availability/fault-tolerance gaps found in the 2026-06-13 audit so a single dependency blip (Twilio, SES, Massive, Supabase) no longer causes silent delivery loss or a total per-minute notification outage.

**Architecture:** Seven independently shippable changes grouped into three priority phases. Phase 1 kills the two highest-frequency user-visible failure modes (last-mile send failures, per-minute cron SPOF) and closes the duplicate-send gap. Phase 2 removes all-or-nothing batch loss and adds runtime observability. Phase 3 is lower-value load/infra hardening with honest caveats.

**Tech Stack:** TypeScript, Astro 5 (SSR on Vercel), AWS Lambda (SAM), Supabase (Postgres), Twilio SDK, AWS SES v2 SDK, Vitest (real local Supabase).

---

## Context / Spec (inline)

This plan implements the findings from the conversational audit on 2026-06-13. The audit's key conclusion: the codebase is already strong on fault tolerance (`Promise.allSettled` everywhere, a DB claim-RPC + reserve/finalize idempotency layer, an SQS+DLQ backfill path, an optional-vendor circuit breaker, per-Lambda error alarms). The remaining gaps are specific seams, not a systemic absence.

Findings → tasks:

| # | Finding | Task | Phase |
|---|---------|------|-------|
| 1 | Twilio + SES sends have no app-level retry; SES has no request timeout ([twilio-utils.ts:90](../../../src/lib/messaging/sms/twilio-utils.ts), [email/utils.ts:144](../../../src/lib/messaging/email/utils.ts)) | Task 1 | 1 |
| 2 | Per-minute schedule cron hard-aborts on market-session lookup ([schedule/run.ts:465](../../../src/lib/schedule/run.ts)) | Task 2 | 1 |
| 3 | Email-dispatch dedup is in-memory only ([email-dispatch.ts:77](../../../src/handlers/email-dispatch.ts)) | Task 3 | 1 |
| 4 | `compute-daily-stats` upsert is all-or-nothing ([compute-daily-stats.ts:126](../../../src/handlers/compute-daily-stats.ts)) | Task 4 | 2 |
| 6 | No runtime health endpoint | Task 5 | 2 |
| 5 | Approval lookup hits DB on every page load, no cache | Task 6 | 3 |
| 7 | No reserved concurrency on high-fan-out Lambdas | Task 7 | 3 |

**Design decision (retry mechanism):** The codebase already hand-rolls explicit retry loops for outbound vendor HTTP (Massive/Finnhub/Grok in `src/lib/providers/`). Messaging is also outbound vendor HTTP, so Task 1 follows that house pattern with one shared `withDeliveryRetry` wrapper rather than each SDK's native retry. Per-attempt timeouts are added at the SDK seam (SES via `abortSignal`, Twilio via the client `timeout` option). Each SDK's own retry is disabled so retries aren't multiplied.

**Note on SMS testability:** Per [twilio-utils.ts:49-54](../../../src/lib/messaging/sms/twilio-utils.ts), SMS has **no live test tier** and the production branch is gated off in tests (`isProduction()` → mock). The `withDeliveryRetry` helper is fully unit-tested in isolation (Task 1, Step 1-4); the Twilio *wiring* is verified by `check:ts` + build, not a unit test. This is called out so "tests pass" is not mistaken for "the Twilio retry path was exercised."

---

# Phase 1 — Highest value, lowest effort

## Task 1: Shared delivery retry + per-attempt timeout for SES and Twilio

**Files:**
- Create: `src/lib/messaging/delivery-retry.ts`
- Test: `tests/lib/messaging/delivery-retry.test.ts`
- Modify: `src/lib/messaging/email/utils.ts` (production SES branch, ~lines 118-159)
- Modify: `src/lib/messaging/sms/twilio-utils.ts` (`createTwilioClient` line 42-44 and production sender branch lines 86-124)

- [ ] **Step 1: Write the failing test for the retry helper**

Create `tests/lib/messaging/delivery-retry.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import {
	isTransientDeliveryError,
	withDeliveryRetry,
} from "../../../src/lib/messaging/delivery-retry";
import type { DeliveryResult } from "../../../src/lib/messaging/types";

const noSleep = () => Promise.resolve();

describe("withDeliveryRetry", () => {
	it("A transient SES throttle succeeds on the second attempt", async () => {
		const results: DeliveryResult[] = [
			{ success: false, error: "throttled", errorCode: "ThrottlingException" },
			{ success: true, messageSid: "ses-msg-1" },
		];
		const send = vi.fn(async () => results.shift() as DeliveryResult);

		const result = await withDeliveryRetry(send, { channel: "email", sleep: noSleep });

		expect(result).toEqual({ success: true, messageSid: "ses-msg-1" });
		expect(send).toHaveBeenCalledTimes(2);
	});

	it("A permanent 400 is not retried", async () => {
		const send = vi.fn(async (): Promise<DeliveryResult> => ({
			success: false,
			error: "bad recipient",
			errorCode: "InvalidParameterValue",
		}));

		const result = await withDeliveryRetry(send, { channel: "email", sleep: noSleep });

		expect(result.success).toBe(false);
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("A vendor down for the whole window exhausts maxAttempts and returns the last failure", async () => {
		const send = vi.fn(async (): Promise<DeliveryResult> => ({
			success: false,
			error: "service unavailable",
			errorCode: "503",
		}));

		const result = await withDeliveryRetry(send, {
			channel: "sms",
			maxAttempts: 3,
			sleep: noSleep,
		});

		expect(result.success).toBe(false);
		expect(send).toHaveBeenCalledTimes(3);
	});

	it("classifies Twilio rate-limit code 20429 as transient", () => {
		expect(isTransientDeliveryError({ success: false, error: "x", errorCode: "20429" })).toBe(true);
		expect(isTransientDeliveryError({ success: false, error: "x", errorCode: "21211" })).toBe(false);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/lib/messaging/delivery-retry.test.ts`
Expected: FAIL — `Cannot find module '../../../src/lib/messaging/delivery-retry'`.

- [ ] **Step 3: Implement the retry helper**

Create `src/lib/messaging/delivery-retry.ts`:

```ts
import { rootLogger } from "../logging";
import type { DeliveryResult } from "./types";

/**
 * Error codes that warrant a retry. Twilio surfaces numeric codes as strings
 * (e.g. "20429"); SES/AWS surface exception names; the abort timeout surfaces
 * "TimeoutError". Everything else (bad recipient, invalid number, auth) is
 * permanent and must NOT be retried.
 */
const TRANSIENT_DELIVERY_ERROR_CODES = new Set<string>([
	"TimeoutError",
	"AbortError",
	"ThrottlingException",
	"TooManyRequestsException",
	"ServiceUnavailable",
	"ServiceUnavailableException",
	"InternalFailure",
	"InternalServerError",
	"500",
	"502",
	"503",
	"504",
	"20429", // Twilio: too many requests
	"20500", // Twilio: internal server error
	"20503", // Twilio: service unavailable
]);

/** True when a failed delivery result is worth retrying. */
export function isTransientDeliveryError(result: DeliveryResult): boolean {
	if (result.success) return false;
	return result.errorCode !== undefined && TRANSIENT_DELIVERY_ERROR_CODES.has(result.errorCode);
}

export interface DeliveryRetryOptions {
	channel: "email" | "sms";
	/** Total attempts including the first. Default 3. */
	maxAttempts?: number;
	/** Base backoff; attempt N waits baseDelayMs * 2^(N-1). Default 500ms. */
	baseDelayMs?: number;
	isTransient?: (result: DeliveryResult) => boolean;
	/** Injected in tests so we don't sleep against real timers. */
	sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retry a single delivery (SMS/email) on transient failure with exponential
 * backoff. Mirrors the explicit retry loops used for Massive/Finnhub/Grok.
 * Logs `warn` per retry, `error` only when all attempts are exhausted.
 */
export async function withDeliveryRetry(
	send: () => Promise<DeliveryResult>,
	options: DeliveryRetryOptions,
): Promise<DeliveryResult> {
	const maxAttempts = options.maxAttempts ?? 3;
	const baseDelayMs = options.baseDelayMs ?? 500;
	const isTransient = options.isTransient ?? isTransientDeliveryError;
	const sleep = options.sleep ?? defaultSleep;

	let lastResult: DeliveryResult = { success: false, error: "no delivery attempt made" };

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		lastResult = await send();
		if (lastResult.success) return lastResult;

		const retriable = isTransient(lastResult) && attempt < maxAttempts;
		if (!retriable) {
			rootLogger.error("Delivery failed", {
				channel: options.channel,
				attempts: attempt,
				errorCode: lastResult.errorCode,
				error: lastResult.error,
			});
			return lastResult;
		}

		const delayMs = baseDelayMs * 2 ** (attempt - 1);
		rootLogger.warn("Transient delivery failure; retrying", {
			channel: options.channel,
			attempt,
			nextDelayMs: delayMs,
			errorCode: lastResult.errorCode,
		});
		await sleep(delayMs);
	}

	return lastResult;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/lib/messaging/delivery-retry.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Apply the wrapper + abort timeout to the SES sender**

In `src/lib/messaging/email/utils.ts`:

Add import at top with the other imports:

```ts
import { withDeliveryRetry } from "../delivery-retry";
```

Change the production SES client construction (line ~119) to disable SDK retry (our wrapper owns retries):

```ts
	// 3. Production: real SES via the default credential chain (Lambda execution role).
	// maxAttempts: 1 — retries are delegated to withDeliveryRetry so they aren't multiplied.
	const sesClient = new SESv2Client({
		region: readEnv("AWS_REGION") || "us-east-1",
		maxAttempts: 1,
	});
```

Replace the returned sender (lines ~123-159) with a wrapped version that adds a 30s abort timeout per attempt:

```ts
	return async ({ to, subject, body, html, replyTo, userId }) =>
		withDeliveryRetry(
			async () => {
				try {
					const replyToValue = replyTo || defaultReplyTo;
					const command = new SendEmailCommand({
						FromEmailAddress: fromEmail,
						Destination: { ToAddresses: [to] },
						ReplyToAddresses: replyToValue ? [replyToValue] : undefined,
						Content: {
							Simple: {
								Subject: { Data: subject, Charset: "UTF-8" },
								Body: {
									Text: { Data: body, Charset: "UTF-8" },
									Html: { Data: html ?? escapeHtml(body), Charset: "UTF-8" },
								},
							},
						},
					});
					await waitForRateLimit();
					// Per-attempt abort: a hung SES socket can otherwise park the Lambda.
					const response = await sesClient.send(command, {
						abortSignal: AbortSignal.timeout(30_000),
					});
					return { success: true, messageSid: response.MessageId };
				} catch (error) {
					return {
						success: false,
						error: error instanceof Error ? error.message : String(error),
						errorCode: error instanceof Error ? error.name : undefined,
					};
				}
			},
			{ channel: "email" },
		);
```

(The per-attempt `rootLogger.error` is removed; `withDeliveryRetry` logs the final failure with `userId`-free context. The `userId` is still available in the dispatch/delivery layer logs.)

- [ ] **Step 6: Apply the wrapper + client timeout to the Twilio sender**

In `src/lib/messaging/sms/twilio-utils.ts`:

Add import:

```ts
import { withDeliveryRetry } from "../delivery-retry";
```

Change `createTwilioClient` (line 42-44) to set a 30s timeout:

```ts
export function createTwilioClient(config: TwilioConfig): TwilioClient {
	// 30s per-request timeout so a hung Twilio API can't park the Lambda.
	// Retries are handled by withDeliveryRetry, not the SDK.
	return twilio(config.accountSid, config.authToken, { timeout: 30_000, autoRetry: false });
}
```

Wrap the production sender branch (lines 86-124) — keep the existing error mapping, wrap it:

```ts
	return async (request: SmsRequest): Promise<DeliveryResult> => {
		const from = request.from ?? defaultFromNumber;

		return withDeliveryRetry(
			async () => {
				try {
					const message = await client.messages.create({
						body: request.body,
						from,
						to: request.to,
					});
					return { success: true, messageSid: message.sid };
				} catch (error) {
					const maskedTo = request.to.slice(-4).padStart(request.to.length, "*");
					rootLogger.warn("Twilio SMS send attempt failed", {
						action: "send_sms",
						from,
						to: maskedTo,
						error: error instanceof Error ? error.message : String(error),
					});

					if (error instanceof Error && "status" in error && "code" in error) {
						const twilioError = error as RestException;
						return {
							success: false,
							error: twilioError.message,
							errorCode: twilioError.code ? String(twilioError.code) : undefined,
						};
					}

					return {
						success: false,
						error: error instanceof Error ? error.message : "Failed to send SMS",
					};
				}
			},
			{ channel: "sms" },
		);
	};
```

- [ ] **Step 7: Type-check (verifies Twilio/SES SDK options exist) and run the messaging suite**

Run: `npm run check:ts`
Expected: PASS. If the Twilio `{ timeout, autoRetry }` options or `abortSignal` on `sesClient.send` do not type-check against the installed SDK versions, stop and adjust — do not assume.

Run: `npm test -- tests/lib/messaging/`
Expected: PASS (existing SMS/email format + new delivery-retry tests).

- [ ] **Step 8: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lib/messaging/delivery-retry.ts tests/lib/messaging/delivery-retry.test.ts \
	src/lib/messaging/email/utils.ts src/lib/messaging/sms/twilio-utils.ts
git commit -m "feat(messaging): retry transient SES/Twilio sends + per-attempt timeout"
```

---

## Task 2: Market-session fallback — remove the per-minute cron SPOF

**Files:**
- Create: `src/lib/schedule/market-session.ts`
- Test: `tests/lib/schedule/market-session.test.ts`
- Modify: `src/lib/schedule/run.ts` (lines 462-474)

- [ ] **Step 1: Write the failing test**

Create `tests/lib/schedule/market-session.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/lib/providers/price-fetcher", () => ({
	getCurrentMarketSession: vi.fn(),
}));

import { getCurrentMarketSession } from "../../../src/lib/providers/price-fetcher";
import {
	__resetMarketSessionCacheForTests,
	resolveMarketSessionWithFallback,
} from "../../../src/lib/schedule/market-session";

const mockGet = vi.mocked(getCurrentMarketSession);

describe("resolveMarketSessionWithFallback", () => {
	beforeEach(() => {
		__resetMarketSessionCacheForTests();
		mockGet.mockReset();
	});

	it("A successful resolve returns the live session and is not degraded", async () => {
		mockGet.mockResolvedValue("regular");
		const result = await resolveMarketSessionWithFallback(1_000);
		expect(result).toEqual({ session: "regular", degraded: false });
	});

	it("A Massive blip within 10 minutes reuses the last good session, marked degraded", async () => {
		mockGet.mockResolvedValueOnce("after");
		await resolveMarketSessionWithFallback(1_000); // seeds cache at t=1s

		mockGet.mockRejectedValueOnce(new Error("Massive 503"));
		const result = await resolveMarketSessionWithFallback(60_000); // 59s later
		expect(result).toEqual({ session: "after", degraded: true });
	});

	it("A failure with no fresh cache defaults to closed (safe: skips price capture, no crash)", async () => {
		mockGet.mockRejectedValueOnce(new Error("Massive 503"));
		const result = await resolveMarketSessionWithFallback(1_000);
		expect(result).toEqual({ session: "closed", degraded: true });
	});

	it("A stale cache older than 10 minutes is not reused", async () => {
		mockGet.mockResolvedValueOnce("regular");
		await resolveMarketSessionWithFallback(1_000);

		mockGet.mockRejectedValueOnce(new Error("Massive 503"));
		const result = await resolveMarketSessionWithFallback(1_000 + 11 * 60_000);
		expect(result).toEqual({ session: "closed", degraded: true });
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/lib/schedule/market-session.test.ts`
Expected: FAIL — cannot find module `market-session`.

- [ ] **Step 3: Implement the fallback resolver**

Create `src/lib/schedule/market-session.ts`:

```ts
import { type MarketSession, getCurrentMarketSession } from "../providers/price-fetcher";

/**
 * Last successfully resolved market session. Persists across warm Lambda
 * invocations (the schedule cron runs every minute and is warm almost always),
 * so a transient Massive `/v1/marketstatus/now` failure reuses the value from
 * the previous minute instead of aborting the entire run.
 */
let cached: { session: MarketSession; atMs: number } | null = null;

/** Max age of a cached session we're willing to reuse during an outage. */
const MAX_STALE_MS = 10 * 60 * 1000;

export interface ResolvedMarketSession {
	session: MarketSession;
	/** True when the value came from cache/default because the live call failed. */
	degraded: boolean;
}

/** Reset module cache (tests only). */
export function __resetMarketSessionCacheForTests(): void {
	cached = null;
}

/**
 * Resolve the current market session, degrading to the last-known-good value
 * (≤10 min old) or to "closed" when Massive is unreachable. Never throws —
 * a vendor blip must not take down the per-minute scheduler.
 */
export async function resolveMarketSessionWithFallback(
	now: number = Date.now(),
): Promise<ResolvedMarketSession> {
	try {
		const session = await getCurrentMarketSession();
		cached = { session, atMs: now };
		return { session, degraded: false };
	} catch {
		if (cached && now - cached.atMs <= MAX_STALE_MS) {
			return { session: cached.session, degraded: true };
		}
		// No fresh cache: "closed" is the safe default — price-history capture is
		// gated on session !== "closed", and scheduled renders degrade to
		// "price unavailable" rather than crashing.
		return { session: "closed", degraded: true };
	}
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/lib/schedule/market-session.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire the resolver into the scheduler**

In `src/lib/schedule/run.ts`, add the import near the other schedule imports:

```ts
import { resolveMarketSessionWithFallback } from "./market-session";
```

Replace the throw-on-failure block (lines 462-474):

```ts
	// Resolve market session once per scheduler invocation — passed to price alerts,
	// both fallback passes, and precompute to avoid redundant Massive status calls.
	// Degrades to the last-known-good session (or "closed") on a Massive blip so a
	// transient vendor failure can't abort the entire per-minute run.
	const { session: schedulerMarketSession, degraded: marketSessionDegraded } =
		await resolveMarketSessionWithFallback();
	if (marketSessionDegraded) {
		logger.warn("Market session resolution degraded (using cached/closed fallback)", {
			action: "market_session",
			session: schedulerMarketSession,
		});
	}
```

Remove the now-unused `MarketSession` local annotation line `let schedulerMarketSession: MarketSession = "closed";` and the surrounding `try/catch`. Confirm `MarketSession` is still imported only where used elsewhere in the file (it is, at line 59).

- [ ] **Step 6: Type-check and run the schedule suite**

Run: `npm run check:ts && npm test -- tests/lib/schedule/`
Expected: PASS. Watch for an unused-import error on `MarketSession` if it's no longer referenced — if so, drop it from the import block.

- [ ] **Step 7: Commit**

```bash
git add src/lib/schedule/market-session.ts tests/lib/schedule/market-session.test.ts src/lib/schedule/run.ts
git commit -m "fix(schedule): degrade market-session lookup instead of aborting the cron"
```

---

## Task 3: Durable email-dispatch idempotency

Replaces the in-memory `seenDispatchKeys` map (lost on cold start, not shared across instances) with a Postgres-backed claim that survives restarts and concurrent invocations.

**Files:**
- Create: `supabase/migrations/<generated>_email_dispatch_idempotency.sql`
- Create: `src/lib/messaging/email/dispatch-idempotency.ts`
- Test: `tests/api/messaging/email-dispatch-idempotency.test.ts`
- Modify: `src/handlers/email-dispatch.ts` (lines 20-21, 77-84, 154-165)
- Modify: `tests/helpers/constants.ts` (line 5)
- Modify: `src/lib/db/generated/database.types.ts` (regenerated)

- [ ] **Step 1: Create the migration**

Run: `supabase migration new email_dispatch_idempotency`

Note the generated filename (e.g. `supabase/migrations/20260613XXXXXX_email_dispatch_idempotency.sql`). Write its contents:

```sql
-- Durable idempotency for the email-dispatch Lambda. Replaces a per-instance
-- in-memory map so duplicate sends are blocked across cold starts and
-- concurrent Lambda instances. service_role only (Lambda uses the secret key).

create table public.email_dispatch_idempotency (
	idempotency_key text primary key,
	created_at timestamptz not null default now()
);

-- Deny-all RLS: only service_role (which bypasses RLS) may touch this table.
alter table public.email_dispatch_idempotency enable row level security;

-- Index supports the opportunistic TTL cleanup below.
create index email_dispatch_idempotency_created_at_idx
	on public.email_dispatch_idempotency (created_at);

grant select, insert, delete on public.email_dispatch_idempotency to service_role;

-- Bump schema version (see AGENTS.md → Testing schema_version).
update public.app_metadata set schema_version = '<generated>_email_dispatch_idempotency';
```

Replace `<generated>` with the actual basename (without `.sql`) of the file you just created.

- [ ] **Step 2: Apply locally and regenerate types**

Run: `npm run db:reset && npm run db:gen-types`
Expected: migration applies; `src/lib/db/generated/database.types.ts` now contains `email_dispatch_idempotency`.

- [ ] **Step 3: Update the expected schema version constant**

In `tests/helpers/constants.ts`, set:

```ts
export const EXPECTED_DB_SCHEMA_VERSION = "<generated>_email_dispatch_idempotency";
```

(Use the same basename as the migration.)

- [ ] **Step 4: Write the failing test**

Create `tests/api/messaging/email-dispatch-idempotency.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { createSupabaseAdminClient } from "../../../src/lib/db/supabase";
import { claimEmailDispatchKey } from "../../../src/lib/messaging/email/dispatch-idempotency";

const TEST_KEY = "scheduled-update/test-user-abc/2026-06-13/540/email";

afterEach(async () => {
	await createSupabaseAdminClient()
		.from("email_dispatch_idempotency")
		.delete()
		.eq("idempotency_key", TEST_KEY);
});

describe("claimEmailDispatchKey", () => {
	it("A first dispatch claims the key; an identical retry is rejected as a duplicate", async () => {
		const supabase = createSupabaseAdminClient();

		const first = await claimEmailDispatchKey(supabase, TEST_KEY);
		expect(first).toBe("claimed");

		const second = await claimEmailDispatchKey(supabase, TEST_KEY);
		expect(second).toBe("duplicate");
	});
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `npm test -- tests/api/messaging/email-dispatch-idempotency.test.ts`
Expected: FAIL — cannot find module `dispatch-idempotency`.

- [ ] **Step 6: Implement the claim helper**

Create `src/lib/messaging/email/dispatch-idempotency.ts`:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../db/generated/database.types";

type AdminClient = SupabaseClient<Database>;

export type DispatchClaimResult = "claimed" | "duplicate";

/** Postgres unique-violation. */
const UNIQUE_VIOLATION = "23505";

/**
 * Atomically claim an email-dispatch idempotency key. Returns "claimed" the
 * first time a key is seen and "duplicate" on any subsequent attempt — durable
 * across Lambda cold starts and concurrent instances, unlike the previous
 * in-memory map.
 */
export async function claimEmailDispatchKey(
	supabase: AdminClient,
	idempotencyKey: string,
): Promise<DispatchClaimResult> {
	const { error } = await supabase
		.from("email_dispatch_idempotency")
		.insert({ idempotency_key: idempotencyKey });

	if (!error) return "claimed";
	if (error.code === UNIQUE_VIOLATION) return "duplicate";
	throw error;
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npm test -- tests/api/messaging/email-dispatch-idempotency.test.ts`
Expected: PASS.

- [ ] **Step 8: Replace the in-memory dedup in the Lambda handler**

In `src/handlers/email-dispatch.ts`:

Delete the in-memory map and its TTL constant (lines 20-21) and the `rememberDispatchKey` function (lines 77-84).

Add the import (with the other `../lib/messaging/email/*` imports):

```ts
import { claimEmailDispatchKey } from "../lib/messaging/email/dispatch-idempotency";
```

Replace the dedup block (lines 154-165). Note the dispatch key must be deterministic for durable dedup — drop the `Date.now()-Math.random()` fallback (it defeats dedup) and require either `idempotencyKey` or `signature`:

```ts
			const dispatchKey = request.idempotencyKey ?? signature;
			if (!dispatchKey) {
				logger.warn("Rejected email dispatch request with no idempotency key or signature", {
					action: "email_dispatch_replay",
					userId: request.userId,
				});
				return jsonResponse(400, {
					success: false,
					error: "Missing idempotency key",
					errorCode: "missing_idempotency_key",
				});
			}

			const claim = await claimEmailDispatchKey(createSupabaseAdminClient(), dispatchKey);
			if (claim === "duplicate") {
				logger.warn("Rejected replayed email dispatch request", {
					action: "email_dispatch_replay",
					userId: request.userId,
				});
				return jsonResponse(409, {
					success: false,
					error: "Duplicate email dispatch request",
					errorCode: "duplicate_request",
				});
			}
```

- [ ] **Step 9: Type-check, run the messaging API suite, build**

Run: `npm run check:ts && npm test -- tests/api/messaging/ && npm run check:knip`
Expected: PASS. `check:knip` confirms no dead exports left behind by the deleted map.

- [ ] **Step 10: Commit**

```bash
git add supabase/migrations/ src/lib/db/generated/database.types.ts \
	src/lib/messaging/email/dispatch-idempotency.ts \
	tests/api/messaging/email-dispatch-idempotency.test.ts \
	src/handlers/email-dispatch.ts tests/helpers/constants.ts
git commit -m "feat(email-dispatch): durable Postgres-backed idempotency for replays"
```

> **Follow-up (out of scope, flag only):** the `email_dispatch_idempotency` table grows unbounded. Add an opportunistic `delete where created_at < now() - interval '2 days'` to an existing daily purge path, or a tiny scheduled cleanup, in a separate change.

---

# Phase 2 — Remove all-or-nothing batch loss; add observability

## Task 4: Chunked daily-stats upsert

Stops a single upsert failure from discarding a full day of computed stats across every symbol.

**Files:**
- Create: `src/lib/market-notifications/daily-stats-upsert.ts`
- Test: `tests/lib/market-notifications/daily-stats-upsert.test.ts`
- Modify: `src/handlers/compute-daily-stats.ts` (lines 125-145)

- [ ] **Step 1: Write the failing test**

Create `tests/lib/market-notifications/daily-stats-upsert.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import {
	type DailyStatsRow,
	upsertDailyStatsInChunks,
} from "../../../src/lib/market-notifications/daily-stats-upsert";

function row(symbol: string): DailyStatsRow {
	return { symbol, computed_at: "2026-06-13", avg_volume_20d: 1_000_000, atr_14: 1.2345 };
}

describe("upsertDailyStatsInChunks", () => {
	it("A clean run upserts every chunk and reports zero failures", async () => {
		const rows = ["AAPL", "MSFT", "NVDA", "TSLA", "AMD"].map(row);
		const upsert = vi.fn(async () => ({ error: null }));

		const result = await upsertDailyStatsInChunks(rows, upsert, 2);

		expect(result).toEqual({ upserted: 5, failedChunks: 0, failedRows: 0 });
		expect(upsert).toHaveBeenCalledTimes(3); // 2 + 2 + 1
	});

	it("A single failing chunk does not discard the chunks that succeeded", async () => {
		const rows = ["AAPL", "MSFT", "NVDA", "TSLA"].map(row);
		const upsert = vi
			.fn()
			.mockResolvedValueOnce({ error: null })
			.mockResolvedValueOnce({ error: { message: "deadlock" } });

		const result = await upsertDailyStatsInChunks(rows, upsert, 2);

		expect(result).toEqual({ upserted: 2, failedChunks: 1, failedRows: 2 });
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/lib/market-notifications/daily-stats-upsert.test.ts`
Expected: FAIL — cannot find module `daily-stats-upsert`.

- [ ] **Step 3: Implement the chunked upsert**

Create `src/lib/market-notifications/daily-stats-upsert.ts`:

```ts
export interface DailyStatsRow {
	symbol: string;
	computed_at: string;
	avg_volume_20d: number | null;
	atr_14: number | null;
}

export interface DailyStatsUpsertResult {
	upserted: number;
	failedChunks: number;
	failedRows: number;
}

/** Executor matches `supabase.from(...).upsert(rows, { onConflict: "symbol" })`. */
export type DailyStatsUpsertExecutor = (
	rows: DailyStatsRow[],
) => Promise<{ error: { message: string } | null }>;

/**
 * Upsert daily stats in independent chunks so one failing chunk (deadlock,
 * transient DB error) doesn't discard the rows that did persist. Returns
 * per-chunk failure counts for alarm logging; never throws.
 */
export async function upsertDailyStatsInChunks(
	rows: DailyStatsRow[],
	upsert: DailyStatsUpsertExecutor,
	chunkSize = 500,
): Promise<DailyStatsUpsertResult> {
	let upserted = 0;
	let failedChunks = 0;
	let failedRows = 0;

	for (let i = 0; i < rows.length; i += chunkSize) {
		const chunk = rows.slice(i, i + chunkSize);
		const { error } = await upsert(chunk);
		if (error) {
			failedChunks++;
			failedRows += chunk.length;
		} else {
			upserted += chunk.length;
		}
	}

	return { upserted, failedChunks, failedRows };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/lib/market-notifications/daily-stats-upsert.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Use the helper in the handler**

In `src/handlers/compute-daily-stats.ts`, add the import:

```ts
import { upsertDailyStatsInChunks } from "../lib/market-notifications/daily-stats-upsert";
```

Replace the all-or-nothing upsert block (lines 125-145):

```ts
		// Upsert all rows in independent chunks so a single chunk failure doesn't
		// discard a full day of computed stats across every symbol.
		if (rows.length > 0) {
			const upsertResult = await upsertDailyStatsInChunks(rows, (chunk) =>
				supabase.from("daily_asset_stats").upsert(chunk, { onConflict: "symbol" }),
			);
			if (upsertResult.failedChunks > 0) {
				// Still an error (alarms fire) but the successful chunks persisted.
				logger.error(
					"Some daily_asset_stats chunks failed to upsert",
					{
						action: "compute_daily_stats",
						upserted: upsertResult.upserted,
						failedChunks: upsertResult.failedChunks,
						failedRows: upsertResult.failedRows,
					},
					new Error("Partial upsert failure"),
				);
			}
		}
```

- [ ] **Step 6: Type-check and run the test + build**

Run: `npm run check:ts && npm test -- tests/lib/market-notifications/daily-stats-upsert.test.ts && npm run build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/market-notifications/daily-stats-upsert.ts \
	tests/lib/market-notifications/daily-stats-upsert.test.ts \
	src/handlers/compute-daily-stats.ts
git commit -m "fix(daily-stats): chunk the upsert so one failure doesn't lose the batch"
```

---

## Task 5: Runtime health endpoint

Gives the platform something to probe (Vercel currently shows green while Supabase is down).

**Files:**
- Create: `src/pages/api/health.ts`
- Test: `tests/api/health.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/api/health.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { GET } from "../../src/pages/api/health";

describe("GET /api/health", () => {
	it("Returns 200 with db ok when Supabase is reachable", async () => {
		const response = await GET();
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toMatchObject({ status: "ok", checks: { db: "ok" } });
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/api/health.test.ts`
Expected: FAIL — cannot find module `../../src/pages/api/health`.

- [ ] **Step 3: Implement the endpoint**

Create `src/pages/api/health.ts`:

```ts
import { createSupabaseAdminClient } from "../../lib/db/supabase";
import { rootLogger } from "../../lib/logging";

export const prerender = false;

/**
 * Lightweight readiness probe. Pings Postgres via a cheap count against
 * app_metadata (a tiny, always-present table). Returns 503 if the DB is
 * unreachable so synthetic monitoring can detect a Supabase outage instead of
 * waiting for a user to hit an authenticated page.
 */
export async function GET(): Promise<Response> {
	let db: "ok" | "error" = "ok";
	try {
		const { error } = await createSupabaseAdminClient()
			.from("app_metadata")
			.select("schema_version", { head: true, count: "exact" });
		if (error) db = "error";
	} catch (error) {
		db = "error";
		rootLogger.warn("Health check DB ping failed", { action: "health_check" }, error);
	}

	const status = db === "ok" ? "ok" : "degraded";
	return new Response(JSON.stringify({ status, checks: { db } }), {
		status: db === "ok" ? 200 : 503,
		headers: { "content-type": "application/json", "cache-control": "no-store" },
	});
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/api/health.test.ts`
Expected: PASS.

- [ ] **Step 5: Confirm the route is public (no auth gate)**

Read `src/middleware.ts` and verify `/api/health` is not caught by an auth/approval guard. If protected routes are matched by prefix, add `/api/health` to the public allowlist there. (If the middleware only guards specific page routes, no change is needed — note which is the case in the commit body.)

- [ ] **Step 6: Type-check and build**

Run: `npm run check:ts && npm run build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/pages/api/health.ts tests/api/health.test.ts
git commit -m "feat(api): add /api/health readiness probe for DB"
```

---

# Phase 3 — Lower value / infra (honest caveats)

## Task 6: Short-TTL approval cache

**Honest scope:** This reduces redundant `approved_at` lookups on every page load and smooths a *brief* DB blip. It does **not** keep the app up during a full Supabase outage — `getCurrentUser` still calls `supabase.auth.setSession` ([db/index.ts:108](../../../src/lib/db/index.ts)), which needs Supabase Auth. It also means a revoked approval lingers up to the TTL. Keep the TTL short (30s) and treat this as load reduction + minor resilience, not a failover.

**Files:**
- Create: `src/lib/db/approval-cache.ts`
- Test: `tests/lib/db/approval-cache.test.ts`
- Modify: `src/lib/db/index.ts` (approval lookup, lines 150-165)

- [ ] **Step 1: Write the failing test**

Create `tests/lib/db/approval-cache.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	__resetApprovalCacheForTests,
	getApprovalCached,
} from "../../../src/lib/db/approval-cache";

describe("getApprovalCached", () => {
	beforeEach(() => __resetApprovalCacheForTests());

	it("A repeated lookup within the TTL hits cache and does not re-query", async () => {
		const lookup = vi.fn(async () => true);

		expect(await getApprovalCached("user-1", lookup, 1_000)).toBe(true);
		expect(await getApprovalCached("user-1", lookup, 1_500)).toBe(true);
		expect(lookup).toHaveBeenCalledTimes(1);
	});

	it("A lookup after the TTL expires re-queries", async () => {
		const lookup = vi.fn(async () => true);

		await getApprovalCached("user-1", lookup, 1_000);
		await getApprovalCached("user-1", lookup, 1_000 + 31_000);
		expect(lookup).toHaveBeenCalledTimes(2);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/lib/db/approval-cache.test.ts`
Expected: FAIL — cannot find module `approval-cache`.

- [ ] **Step 3: Implement the cache**

Create `src/lib/db/approval-cache.ts`:

```ts
/**
 * Per-instance, short-TTL cache of user approval status. Cuts redundant
 * `approved_at` queries on every page load. NOT a failover: see the approval
 * cache note in the HA hardening plan. Cache is per serverless instance.
 */
const TTL_MS = 30_000;

const cache = new Map<string, { approved: boolean; atMs: number }>();

/** Reset cache (tests only). */
export function __resetApprovalCacheForTests(): void {
	cache.clear();
}

/**
 * Return cached approval if fresh, otherwise call `lookup`, cache, and return.
 * Only positive AND negative results are cached for TTL; this means a freshly
 * approved user may wait up to TTL_MS — acceptable for a 30s window.
 */
export async function getApprovalCached(
	userId: string,
	lookup: () => Promise<boolean>,
	now: number = Date.now(),
	ttlMs: number = TTL_MS,
): Promise<boolean> {
	const hit = cache.get(userId);
	if (hit && now - hit.atMs <= ttlMs) {
		return hit.approved;
	}
	const approved = await lookup();
	cache.set(userId, { approved, atMs: now });
	return approved;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/lib/db/approval-cache.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Use the cache in the approval lookup**

In `src/lib/db/index.ts`, add the import:

```ts
import { getApprovalCached } from "./approval-cache";
```

Wrap the approval query (lines 150-165). The lookup callback preserves the existing error semantics (a DB error logs and is treated as not-approved → returns false, which surfaces as `null` user — unchanged behavior, just cached):

```ts
				const approved = await getApprovalCached(authUser.id, async () => {
					const { data: dbUser, error: dbUserError } = await supabase
						.from("users")
						.select("approved_at")
						.eq("id", authUser.id)
						.maybeSingle();
					if (dbUserError) {
						rootLogger.error("approval lookup failed", {
							error: dbUserError.message,
							userId: authUser.id,
						});
						return false;
					}
					return isApprovedAtValue(dbUser?.approved_at ?? null);
				});

				if (!approved) {
					return null;
				}

				return authUser;
```

> Note: caching a `false` from a transient DB error for 30s is a deliberate trade — it prevents a thundering herd of failed lookups during a blip. If you'd rather never cache the error path, return early without caching by throwing inside the callback and catching outside; keep it simple unless review objects.

- [ ] **Step 6: Type-check and run the db suite + build**

Run: `npm run check:ts && npm test -- tests/lib/db/ && npm run build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/db/approval-cache.ts tests/lib/db/approval-cache.test.ts src/lib/db/index.ts
git commit -m "perf(auth): short-TTL approval cache to cut per-load DB lookups"
```

---

## Task 7: Reserved concurrency on high-fan-out Lambdas (infra)

**Honest scope:** Modest value — the per-minute schedule cron is a single invocation, so reserved concurrency mainly guarantees it can always run even if other functions saturate the account's concurrency pool. No unit test applies; this is an infra change verified by `sam validate` and requires a **full SAM deploy** (`npm run deploy:aws` with admin creds — code-only pushes don't apply `template.yaml` changes; see AGENTS.md → "AWS / SAM Deploy").

**Files:**
- Modify: `aws/template.yaml` (`ScheduleFunction` ~line 87, `AssetEventsFunction` ~line 136)

- [ ] **Step 1: Add reserved concurrency to ScheduleFunction**

In `aws/template.yaml`, under `ScheduleFunction:` `Properties:` (alongside `Timeout: 300`), add:

```yaml
      ReservedConcurrentExecutions: 5
```

- [ ] **Step 2: Add reserved concurrency to AssetEventsFunction**

Under `AssetEventsFunction:` `Properties:`, add:

```yaml
      ReservedConcurrentExecutions: 2
```

- [ ] **Step 3: Validate the template**

Run: `sam validate --lint --template aws/template.yaml`
Expected: `aws/template.yaml is a valid SAM Template`.

If `sam` is not installed locally, instead run `npm run check:ts && npm run build` to confirm nothing else broke, and validate during the deploy.

- [ ] **Step 4: Commit (deploy is a separate, deliberate step)**

```bash
git add aws/template.yaml
git commit -m "chore(infra): reserve concurrency for schedule + asset-events Lambdas"
```

> **Deploy reminder:** this only takes effect after `npm run deploy:aws` (full SAM deploy, admin creds). Do not assume the pre-push code deploy applies it.

---

## Self-Review

- **Spec coverage:** All 7 audit findings map to a task (table in Context). Findings already-solid (Massive/Finnhub/Grok timeouts, circuit breaker, claim-RPC) are intentionally untouched.
- **Type consistency:** `DeliveryResult` (Task 1) reused from `src/lib/messaging/types.ts`. `MarketSession` (Task 2) imported from `price-fetcher.ts`. `claimEmailDispatchKey` returns `"claimed" | "duplicate"` consistently in handler + test. `upsertDailyStatsInChunks` signature matches its test and handler call site.
- **Placeholder scan:** No "TBD"/"add error handling" placeholders; all code blocks are concrete. The only deferred items are explicitly flagged as out-of-scope follow-ups (idempotency-table TTL cleanup).
- **Migration discipline (Task 3):** follows AGENTS.md — explicit `grant ... to service_role`, RLS enabled, `schema_version` bumped in SQL, `EXPECTED_DB_SCHEMA_VERSION` updated, `db:gen-types` run. No `.rpc` function, so no `privilege-contract.ts` classification needed.

---

## Execution order recommendation

Ship **Phase 1 (Tasks 1-3)** first — smallest diffs, kills the two highest-frequency user-visible failure modes and closes the duplicate-send gap. Then Phase 2, then Phase 3 if time allows. Each task is independently committable and shippable via `/ship`.
