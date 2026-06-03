# Approval Email Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-06-03-approval-email-design.md`

**Goal:** Add a small app-admin approval workflow that sends a user-facing email when a pending user is approved, while keeping migration-grandfathered users silent.

**Architecture:** Admin authorization is an environment allowlist checked server-side against the signed-in auth user's email. A new `/admin/users` page lists pending users and posts to a server-only approval API. The approval API updates `approved_at`/`approved_by` with the admin Supabase client, then sends the user-facing approval email through the existing email sender.

**Tech Stack:** Astro SSR/API routes, Supabase Auth/Postgres, existing `createUserService()`, existing `createEmailSender()`, Vitest, Astro Container page tests, Mailpit/SES via existing email infrastructure.

---

## File Structure

- Create `src/lib/auth/approval-admin.ts` for pure admin allowlist parsing and runtime admin checks.
- Create `src/lib/auth/approval-user-email.ts` for the user-facing approval email helper.
- Create `src/lib/auth/approve-user.ts` for the approval transaction-ish workflow shared by the API and tests.
- Create `src/pages/admin/users.astro` for the minimal pending-user approval page.
- Create `src/pages/api/admin/users/approve.ts` for the approve POST action.
- Modify `src/types/env.d.ts`, `env.example`, `README.md`, and `docs/tooling-setup.md` to document `APPROVAL_ADMIN_EMAILS`.
- Add tests in:
  - `tests/lib/auth/approval-admin.test.ts`
  - `tests/lib/auth/approval-user-email.test.ts`
  - `tests/lib/auth/approve-user.test.ts`
  - `tests/api/admin/users/approve.test.ts`
  - `tests/pages/pages-render.test.ts`

## Task 1: Admin allowlist helper

**Files:**

- Create: `src/lib/auth/approval-admin.ts`
- Test: `tests/lib/auth/approval-admin.test.ts`

- [ ] **Step 1: Write failing tests for parsing and checks**

Create `tests/lib/auth/approval-admin.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import {
 getApprovalAdminEmails,
 isApprovalAdminEmail,
 parseApprovalAdminEmails,
} from "../../../src/lib/auth/approval-admin";

describe("approval admin allowlist", () => {
 afterEach(() => {
  vi.unstubAllEnvs();
 });

 it("parses comma-separated emails case-insensitively and trims whitespace.", () => {
  expect(parseApprovalAdminEmails(" test@jsolly.com, ADMIN@example.com ,, ")).toEqual(
   new Set(["test@jsolly.com", "admin@example.com"]),
  );
 });

 it("returns an empty set when the env value is missing or blank.", () => {
  expect(parseApprovalAdminEmails(undefined)).toEqual(new Set());
  expect(parseApprovalAdminEmails("   ")).toEqual(new Set());
 });

 it("recognizes test@jsolly.com when configured for local development.", () => {
  vi.stubEnv("APPROVAL_ADMIN_EMAILS", "test@jsolly.com");

  expect(getApprovalAdminEmails()).toEqual(new Set(["test@jsolly.com"]));
  expect(isApprovalAdminEmail("test@jsolly.com")).toBe(true);
 });

 it("rejects missing emails and emails not in the allowlist.", () => {
  vi.stubEnv("APPROVAL_ADMIN_EMAILS", "test@jsolly.com");

  expect(isApprovalAdminEmail(null)).toBe(false);
  expect(isApprovalAdminEmail(undefined)).toBe(false);
  expect(isApprovalAdminEmail("other@example.com")).toBe(false);
 });
});
```

- [ ] **Step 2: Run the failing tests**

Run:

```bash
npm test -- tests/lib/auth/approval-admin.test.ts
```

Expected: FAIL because `src/lib/auth/approval-admin.ts` does not exist.

- [ ] **Step 3: Implement the helper**

Create `src/lib/auth/approval-admin.ts`:

```ts
import { readEnv } from "../db/env";

const APPROVAL_ADMIN_EMAILS_ENV = "APPROVAL_ADMIN_EMAILS";

export function parseApprovalAdminEmails(value: string | undefined): Set<string> {
 return new Set(
  (value ?? "")
   .split(",")
   .map((email) => email.trim().toLowerCase())
   .filter((email) => email.length > 0),
 );
}

export function getApprovalAdminEmails(): Set<string> {
 return parseApprovalAdminEmails(readEnv(APPROVAL_ADMIN_EMAILS_ENV));
}

export function isApprovalAdminEmail(email: string | null | undefined): boolean {
 if (!email) return false;
 return getApprovalAdminEmails().has(email.trim().toLowerCase());
}
```

- [ ] **Step 4: Verify tests pass**

Run:

```bash
npm test -- tests/lib/auth/approval-admin.test.ts
```

Expected: PASS.

## Task 2: User-facing approval email helper

**Files:**

- Create: `src/lib/auth/approval-user-email.ts`
- Test: `tests/lib/auth/approval-user-email.test.ts`

- [ ] **Step 1: Write failing tests for email content and failure logging**

Create `tests/lib/auth/approval-user-email.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EmailSender } from "../../../src/lib/messaging/email/utils";
import { expectConsoleError } from "../../setup";

const mockEmailSender = vi.hoisted(() =>
 vi.fn<EmailSender>(async () => ({
  success: true,
  messageSid: "approval-email",
 })),
);

vi.mock("../../../src/lib/messaging/email/utils", async (importOriginal) => {
 const actual = await importOriginal<typeof import("../../../src/lib/messaging/email/utils")>();
 return {
  ...actual,
  createEmailSender: () => mockEmailSender,
 };
});

describe("sendUserApprovalEmail", () => {
 afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
 });

 it("sends a user-facing approval email with the sign-in link.", async () => {
  vi.stubEnv("EMAIL_FROM", "StockTextAlerts <notify@example.com>");
  vi.stubEnv("VERCEL_URL", "http://localhost:4321");
  const { sendUserApprovalEmail } = await import("../../../src/lib/auth/approval-user-email");
  const { createLogger } = await import("../../../src/lib/logging");

  const result = await sendUserApprovalEmail(
   { id: "user-1", email: "new-user@example.com" },
   createLogger({ path: "/test", method: "POST" }),
  );

  expect(result.success).toBe(true);
  expect(mockEmailSender).toHaveBeenCalledWith(
   expect.objectContaining({
    to: "new-user@example.com",
    subject: "Your StockTextAlerts account is approved",
    body: expect.stringContaining("http://localhost:4321/auth/signin"),
    userId: "user-1",
    idempotencyKey: "user-approved-user-1",
   }),
  );
 });

 it("returns failure and logs when the email sender fails.", async () => {
  expectConsoleError("Failed to send user approval email");
  mockEmailSender.mockResolvedValueOnce({
   success: false,
   error: "SMTP down",
   errorCode: "smtp_error",
  });
  vi.stubEnv("EMAIL_FROM", "StockTextAlerts <notify@example.com>");
  const { sendUserApprovalEmail } = await import("../../../src/lib/auth/approval-user-email");
  const { createLogger } = await import("../../../src/lib/logging");

  const result = await sendUserApprovalEmail(
   { id: "user-2", email: "new-user@example.com" },
   createLogger({ path: "/test", method: "POST" }),
  );

  expect(result.success).toBe(false);
  expect(result.errorCode).toBe("smtp_error");
 });
});
```

- [ ] **Step 2: Run the failing tests**

Run:

```bash
npm test -- tests/lib/auth/approval-user-email.test.ts
```

Expected: FAIL because `src/lib/auth/approval-user-email.ts` does not exist.

- [ ] **Step 3: Implement the helper**

Create `src/lib/auth/approval-user-email.ts`:

```ts
import { getSiteUrl } from "../db/env";
import type { Logger } from "../logging";
import type { DeliveryResult } from "../messaging/types";
import { createEmailSender } from "../messaging/email/utils";

type ApprovedUser = {
 id: string;
 email: string;
};

export async function sendUserApprovalEmail(
 user: ApprovedUser,
 logger: Logger,
): Promise<DeliveryResult> {
 const signInUrl = `${getSiteUrl()}/auth/signin`;
 const body = [
  "Your StockTextAlerts account has been approved.",
  "",
  "You can now sign in and set up your stock alerts:",
  signInUrl,
 ].join("\n");

 const result = await createEmailSender()({
  to: user.email,
  subject: "Your StockTextAlerts account is approved",
  body,
  idempotencyKey: `user-approved-${user.id}`,
  userId: user.id,
 });

 if (!result.success) {
  logger.error("Failed to send user approval email", {
   userId: user.id,
   error: result.error,
   errorCode: result.errorCode,
  });
 }

 return result;
}
```

- [ ] **Step 4: Verify tests pass**

Run:

```bash
npm test -- tests/lib/auth/approval-user-email.test.ts
```

Expected: PASS.

## Task 3: Approval workflow service

**Files:**

- Create: `src/lib/auth/approve-user.ts`
- Test: `tests/lib/auth/approve-user.test.ts`

- [ ] **Step 1: Write failing tests for approval outcomes**

Create `tests/lib/auth/approve-user.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EmailSender } from "../../../src/lib/messaging/email/utils";
import { TEST_PASSWORD } from "../../helpers/constants";
import { adminClient } from "../../helpers/test-env";
import { createTestUser } from "../../helpers/test-user";
import { registerTestUserForCleanup } from "../../helpers/test-user-cleanup";
import { expectConsoleError } from "../../setup";

const mockEmailSender = vi.hoisted(() =>
 vi.fn<EmailSender>(async () => ({
  success: true,
  messageSid: "approval-email",
 })),
);

vi.mock("../../../src/lib/messaging/email/utils", async (importOriginal) => {
 const actual = await importOriginal<typeof import("../../../src/lib/messaging/email/utils")>();
 return {
  ...actual,
  createEmailSender: () => mockEmailSender,
 };
});

describe("approvePendingUser", () => {
 afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
 });

 it("approves a pending user and sends exactly one approval email.", async () => {
  vi.stubEnv("EMAIL_FROM", "StockTextAlerts <notify@example.com>");
  const pendingUser = await createTestUser({
   email: `pending-${randomUUID()}@example.com`,
   password: TEST_PASSWORD,
   confirmed: true,
   approved: false,
  });
  registerTestUserForCleanup(pendingUser.id);
  const { approvePendingUser } = await import("../../../src/lib/auth/approve-user");
  const { createLogger } = await import("../../../src/lib/logging");

  const result = await approvePendingUser({
   adminSupabase: adminClient,
   targetUserId: pendingUser.id,
   approvedBy: "test@jsolly.com",
   logger: createLogger({ path: "/test", method: "POST" }),
  });

  expect(result.status).toBe("approved");
  expect(result.emailSent).toBe(true);
  expect(mockEmailSender).toHaveBeenCalledOnce();
  const { data: row, error } = await adminClient
   .from("users")
   .select("approved_at, approved_by")
   .eq("id", pendingUser.id)
   .single();
  expect(error).toBeNull();
  expect(row?.approved_at).toBeTruthy();
  expect(row?.approved_by).toBe("test@jsolly.com");
 });

 it("does not send an email for an already-approved user.", async () => {
  const approvedUser = await createTestUser({
   email: `approved-${randomUUID()}@example.com`,
   password: TEST_PASSWORD,
   confirmed: true,
   approved: true,
  });
  registerTestUserForCleanup(approvedUser.id);
  const { approvePendingUser } = await import("../../../src/lib/auth/approve-user");
  const { createLogger } = await import("../../../src/lib/logging");

  const result = await approvePendingUser({
   adminSupabase: adminClient,
   targetUserId: approvedUser.id,
   approvedBy: "test@jsolly.com",
   logger: createLogger({ path: "/test", method: "POST" }),
  });

  expect(result.status).toBe("already_approved");
  expect(result.emailSent).toBe(false);
  expect(mockEmailSender).not.toHaveBeenCalled();
 });

 it("keeps the user approved when approval email delivery fails.", async () => {
  expectConsoleError("Failed to send user approval email");
  mockEmailSender.mockResolvedValueOnce({
   success: false,
   error: "SMTP down",
   errorCode: "smtp_error",
  });
  const pendingUser = await createTestUser({
   email: `email-fails-${randomUUID()}@example.com`,
   password: TEST_PASSWORD,
   confirmed: true,
   approved: false,
  });
  registerTestUserForCleanup(pendingUser.id);
  const { approvePendingUser } = await import("../../../src/lib/auth/approve-user");
  const { createLogger } = await import("../../../src/lib/logging");

  const result = await approvePendingUser({
   adminSupabase: adminClient,
   targetUserId: pendingUser.id,
   approvedBy: "test@jsolly.com",
   logger: createLogger({ path: "/test", method: "POST" }),
  });

  expect(result.status).toBe("approved_email_failed");
  expect(result.emailSent).toBe(false);
  const { data: row } = await adminClient
   .from("users")
   .select("approved_at, approved_by")
   .eq("id", pendingUser.id)
   .single();
  expect(row?.approved_at).toBeTruthy();
  expect(row?.approved_by).toBe("test@jsolly.com");
 });

 it("returns not_found when the target user does not exist.", async () => {
  const { approvePendingUser } = await import("../../../src/lib/auth/approve-user");
  const { createLogger } = await import("../../../src/lib/logging");

  const result = await approvePendingUser({
   adminSupabase: adminClient,
   targetUserId: randomUUID(),
   approvedBy: "test@jsolly.com",
   logger: createLogger({ path: "/test", method: "POST" }),
  });

  expect(result.status).toBe("not_found");
  expect(mockEmailSender).not.toHaveBeenCalled();
 });
});
```

- [ ] **Step 2: Run the failing tests**

Run:

```bash
npm test -- tests/lib/auth/approve-user.test.ts
```

Expected: FAIL because `src/lib/auth/approve-user.ts` does not exist.

- [ ] **Step 3: Implement the approval workflow**

Create `src/lib/auth/approve-user.ts`:

```ts
import type { Logger } from "../logging";
import type { AppSupabaseClient } from "../db/supabase";
import { sendUserApprovalEmail } from "./approval-user-email";

type ApprovePendingUserOptions = {
 adminSupabase: AppSupabaseClient;
 targetUserId: string;
 approvedBy: string;
 logger: Logger;
};

export type ApprovePendingUserResult =
 | { status: "approved"; emailSent: true; email: string }
 | { status: "approved_email_failed"; emailSent: false; email: string }
 | { status: "already_approved"; emailSent: false; email: string }
 | { status: "not_found"; emailSent: false };

export async function approvePendingUser(
 options: ApprovePendingUserOptions,
): Promise<ApprovePendingUserResult> {
 const { adminSupabase, targetUserId, approvedBy, logger } = options;

 const { data: targetUser, error: fetchError } = await adminSupabase
  .from("users")
  .select("id, email, approved_at")
  .eq("id", targetUserId)
  .maybeSingle();

 if (fetchError) {
  logger.error("Failed to load user for approval", { userId: targetUserId }, fetchError);
  throw fetchError;
 }

 if (!targetUser) {
  return { status: "not_found", emailSent: false };
 }

 if (targetUser.approved_at) {
  return { status: "already_approved", emailSent: false, email: targetUser.email };
 }

 const approvedAt = new Date().toISOString();
 const { data: updatedRows, error: updateError } = await adminSupabase
  .from("users")
  .update({
   approved_at: approvedAt,
   approved_by: approvedBy,
  })
  .eq("id", targetUserId)
  .is("approved_at", null)
  .select("id, email")
  .limit(1);

 if (updateError) {
  logger.error("Failed to approve user", { userId: targetUserId }, updateError);
  throw updateError;
 }

 const updatedUser = updatedRows?.[0];
 if (!updatedUser) {
  return { status: "already_approved", emailSent: false, email: targetUser.email };
 }

 const emailResult = await sendUserApprovalEmail(
  { id: updatedUser.id, email: updatedUser.email },
  logger,
 );

 if (!emailResult.success) {
  return { status: "approved_email_failed", emailSent: false, email: updatedUser.email };
 }

 return { status: "approved", emailSent: true, email: updatedUser.email };
}
```

- [ ] **Step 4: Verify workflow tests pass**

Run:

```bash
npm test -- tests/lib/auth/approve-user.test.ts
```

Expected: PASS.

## Task 4: Admin approve API

**Files:**

- Create: `src/pages/api/admin/users/approve.ts`
- Test: `tests/api/admin/users/approve.test.ts`

- [ ] **Step 1: Write failing API tests**

Create `tests/api/admin/users/approve.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EmailSender } from "../../../../src/lib/messaging/email/utils";
import { POST } from "../../../../src/pages/api/admin/users/approve";
import { createApiContext } from "../../../helpers/api-context";
import { TEST_PASSWORD } from "../../../helpers/constants";
import { createAuthenticatedCookies } from "../../../helpers/test-env";
import { createTestUser } from "../../../helpers/test-user";
import { registerTestUserForCleanup } from "../../../helpers/test-user-cleanup";
import { expectConsoleError } from "../../../setup";

const mockEmailSender = vi.hoisted(() =>
 vi.fn<EmailSender>(async () => ({
  success: true,
  messageSid: "approval-email",
 })),
);

vi.mock("../../../../src/lib/messaging/email/utils", async (importOriginal) => {
 const actual = await importOriginal<typeof import("../../../../src/lib/messaging/email/utils")>();
 return {
  ...actual,
  createEmailSender: () => mockEmailSender,
 };
});

function makeRequest(userId: string) {
 return new Request("http://localhost/api/admin/users/approve", {
  method: "POST",
  body: new URLSearchParams({ user_id: userId }),
 });
}

describe("admin user approval API", () => {
 afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
 });

 it("redirects logged-out requests to sign in.", async () => {
  const response = await POST(createApiContext({ request: makeRequest(randomUUID()) }));

  expect(response.status).toBe(302);
  expect(response.headers.get("Location")).toBe(
   "/auth/signin?redirect=%2Fapi%2Fadmin%2Fusers%2Fapprove",
  );
 });

 it("rejects signed-in users outside APPROVAL_ADMIN_EMAILS.", async () => {
  vi.stubEnv("APPROVAL_ADMIN_EMAILS", "test@jsolly.com");
  const user = await createTestUser({
   email: `not-admin-${randomUUID()}@example.com`,
   password: TEST_PASSWORD,
   confirmed: true,
   approved: true,
  });
  registerTestUserForCleanup(user.id);
  const cookies = await createAuthenticatedCookies(user.email, TEST_PASSWORD);

  const response = await POST(createApiContext({ request: makeRequest(randomUUID()), cookies }));

  expect(response.status).toBe(403);
  expect(await response.text()).toContain("Forbidden");
 });

 it("approves a pending user and redirects with success.", async () => {
  vi.stubEnv("APPROVAL_ADMIN_EMAILS", "admin@example.com");
  vi.stubEnv("EMAIL_FROM", "StockTextAlerts <notify@example.com>");
  const admin = await createTestUser({
   email: "admin@example.com",
   password: TEST_PASSWORD,
   confirmed: true,
   approved: true,
  });
  registerTestUserForCleanup(admin.id);
  const pending = await createTestUser({
   email: `pending-${randomUUID()}@example.com`,
   password: TEST_PASSWORD,
   confirmed: true,
   approved: false,
  });
  registerTestUserForCleanup(pending.id);
  const cookies = await createAuthenticatedCookies(admin.email, TEST_PASSWORD);

  const response = await POST(createApiContext({ request: makeRequest(pending.id), cookies }));

  expect(response.status).toBe(302);
  expect(response.headers.get("Location")).toBe("/admin/users?success=approved");
  expect(mockEmailSender).toHaveBeenCalledOnce();
 });

 it("does not email an already-approved user.", async () => {
  vi.stubEnv("APPROVAL_ADMIN_EMAILS", "admin@example.com");
  const admin = await createTestUser({
   email: "admin@example.com",
   password: TEST_PASSWORD,
   confirmed: true,
   approved: true,
  });
  registerTestUserForCleanup(admin.id);
  const approved = await createTestUser({
   email: `approved-${randomUUID()}@example.com`,
   password: TEST_PASSWORD,
   confirmed: true,
   approved: true,
  });
  registerTestUserForCleanup(approved.id);
  const cookies = await createAuthenticatedCookies(admin.email, TEST_PASSWORD);

  const response = await POST(createApiContext({ request: makeRequest(approved.id), cookies }));

  expect(response.status).toBe(302);
  expect(response.headers.get("Location")).toBe("/admin/users?info=already_approved");
  expect(mockEmailSender).not.toHaveBeenCalled();
 });

 it("keeps approval when email fails and redirects with warning.", async () => {
  expectConsoleError("Failed to send user approval email");
  mockEmailSender.mockResolvedValueOnce({
   success: false,
   error: "SMTP down",
   errorCode: "smtp_error",
  });
  vi.stubEnv("APPROVAL_ADMIN_EMAILS", "admin@example.com");
  const admin = await createTestUser({
   email: "admin@example.com",
   password: TEST_PASSWORD,
   confirmed: true,
   approved: true,
  });
  registerTestUserForCleanup(admin.id);
  const pending = await createTestUser({
   email: `email-fail-${randomUUID()}@example.com`,
   password: TEST_PASSWORD,
   confirmed: true,
   approved: false,
  });
  registerTestUserForCleanup(pending.id);
  const cookies = await createAuthenticatedCookies(admin.email, TEST_PASSWORD);

  const response = await POST(createApiContext({ request: makeRequest(pending.id), cookies }));

  expect(response.status).toBe(302);
  expect(response.headers.get("Location")).toBe("/admin/users?warning=email_failed");
 });
});
```

- [ ] **Step 2: Run the failing API tests**

Run:

```bash
npm test -- tests/api/admin/users/approve.test.ts
```

Expected: FAIL because the API route does not exist.

- [ ] **Step 3: Implement the API route**

Create `src/pages/api/admin/users/approve.ts`:

```ts
import type { APIRoute } from "astro";
import { isApprovalAdminEmail } from "../../../../lib/auth/approval-admin";
import { buildSigninRedirectUrl } from "../../../../lib/auth/redirects";
import { approvePendingUser } from "../../../../lib/auth/approve-user";
import { createUserService } from "../../../../lib/db";
import { createSupabaseAdminClient, createSupabaseServerClient } from "../../../../lib/db/supabase";
import { createLogger } from "../../../../lib/logging";

function redirectForResult(status: string): string {
 switch (status) {
  case "approved":
   return "/admin/users?success=approved";
  case "approved_email_failed":
   return "/admin/users?warning=email_failed";
  case "already_approved":
   return "/admin/users?info=already_approved";
  case "not_found":
   return "/admin/users?error=user_not_found";
  default:
   return "/admin/users?error=failed";
 }
}

export const POST: APIRoute = async ({ request, cookies, locals, redirect }) => {
 const logger = createLogger({
  requestId: locals?.requestId,
  path: new URL(request.url).pathname,
  method: request.method,
 });
 const supabase = createSupabaseServerClient();
 const users = createUserService(supabase, cookies);
 const authUser = await users.getCurrentUser();

 if (!authUser) {
  return redirect(buildSigninRedirectUrl("/api/admin/users/approve"));
 }

 if (!isApprovalAdminEmail(authUser.email)) {
  logger.info("Non-admin attempted to approve user", { userId: authUser.id });
  return new Response("Forbidden", { status: 403 });
 }

 const formData = await request.formData();
 const targetUserId = formData.get("user_id");
 if (typeof targetUserId !== "string" || targetUserId.trim().length === 0) {
  return redirect("/admin/users?error=invalid_form");
 }

 try {
  const result = await approvePendingUser({
   adminSupabase: createSupabaseAdminClient(),
   targetUserId,
   approvedBy: authUser.email ?? authUser.id,
   logger,
  });

  return redirect(redirectForResult(result.status));
 } catch (error) {
  logger.error("Admin user approval failed", { adminUserId: authUser.id, targetUserId }, error);
  return redirect("/admin/users?error=failed");
 }
};
```

- [ ] **Step 4: Verify API tests pass**

Run:

```bash
npm test -- tests/api/admin/users/approve.test.ts
```

Expected: PASS.

## Task 5: Admin users page

**Files:**

- Create: `src/pages/admin/users.astro`
- Modify: `tests/pages/pages-render.test.ts`

- [ ] **Step 1: Add failing page tests**

Modify `tests/pages/pages-render.test.ts`:

1. Add import:

```ts
import AdminUsersPage from "../../src/pages/admin/users.astro";
```

1. Add tests inside `describe("Users can load pages without unexpected errors.", () => { ... })`:

```ts
it("A logged-out visitor is redirected to sign-in when opening the admin users page.", async () => {
 const container = await AstroContainer.create({ renderers });
 const response = await container.renderToResponse(AdminUsersPage, {
  request: buildRequest("/admin/users"),
 });

 expect(response.status).toBe(302);
 expect(response.headers.get("Location")).toBe("/auth/signin?redirect=%2Fadmin%2Fusers");
});

it("A non-admin signed-in user cannot view the admin users page.", async () => {
 vi.stubEnv("APPROVAL_ADMIN_EMAILS", "test@jsolly.com");
 await withTestUser(
  {
   email: createTestEmail("not-admin"),
   password: TEST_PASSWORD,
   confirmed: true,
   approved: true,
  },
  async (_user, cookies) => {
   const container = await AstroContainer.create({ renderers });
   const response = await container.renderToResponse(AdminUsersPage, {
    request: buildRequest("/admin/users", cookies),
   });

   expect(response.status).toBe(403);
  },
 );
});

it("An allowlisted admin can view pending users.", async () => {
 vi.stubEnv("APPROVAL_ADMIN_EMAILS", "admin@example.com");
 await withTestUser(
  {
   email: "admin@example.com",
   password: TEST_PASSWORD,
   confirmed: true,
   approved: true,
  },
  async (_admin, cookies) => {
   const pending = await createTestUser({
    email: createTestEmail("pending-admin-list"),
    password: TEST_PASSWORD,
    confirmed: true,
    approved: false,
   });
   try {
    const container = await AstroContainer.create({ renderers });
    const response = await container.renderToResponse(AdminUsersPage, {
     request: buildRequest("/admin/users", cookies),
    });
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain(pending.email);
    expect(html).toContain("/api/admin/users/approve");
   } finally {
    await cleanupTestUser(pending.id);
   }
  },
 );
});
```

1. Update the `afterEach` block to clear env stubs:

```ts
afterEach(() => {
 expectConsoleWarning(/^Cleanup failed/);
 vi.unstubAllEnvs();
});
```

- [ ] **Step 2: Run failing page tests**

Run:

```bash
npm test -- tests/pages/pages-render.test.ts
```

Expected: FAIL because `src/pages/admin/users.astro` does not exist.

- [ ] **Step 3: Implement the admin page**

Create `src/pages/admin/users.astro`:

```astro
---
import Navigation from "../../components/Navigation.astro";
import StatusMessage from "../../components/StatusMessage.astro";
import Layout from "../../layouts/Layout.astro";
import { isApprovalAdminEmail } from "../../lib/auth/approval-admin";
import { buildSigninRedirectUrl } from "../../lib/auth/redirects";
import { createUserService } from "../../lib/db";
import { createSupabaseAdminClient, createSupabaseServerClient } from "../../lib/db/supabase";
import { rootLogger } from "../../lib/logging";

const supabase = createSupabaseServerClient();
const users = createUserService(supabase, Astro.cookies);
const authUser = await users.getCurrentUser();

if (!authUser) {
 return Astro.redirect(buildSigninRedirectUrl(`${Astro.url.pathname}${Astro.url.search}`));
}

if (!isApprovalAdminEmail(authUser.email)) {
 rootLogger.info("Non-admin attempted to view pending users", { userId: authUser.id });
 return new Response("Forbidden", { status: 403 });
}

const adminSupabase = createSupabaseAdminClient();
const { data: pendingUsers, error: pendingUsersError } = await adminSupabase
 .from("users")
 .select("id, email, timezone, created_at")
 .is("approved_at", null)
 .order("created_at", { ascending: true });

if (pendingUsersError) {
 rootLogger.error("Failed to load pending users", { adminUserId: authUser.id }, pendingUsersError);
 return new Response("Failed to load pending users", { status: 500 });
}

const success = Astro.url.searchParams.get("success");
const warning = Astro.url.searchParams.get("warning");
const info = Astro.url.searchParams.get("info");
const error = Astro.url.searchParams.get("error");
---
<Layout title="Pending Users | StockTextAlerts" description="Approve pending StockTextAlerts users." noindex>
  <div class="min-h-screen bg-surface-alt">
    <header>
      <Navigation user={authUser} />
    </header>

    <main id="main-content" class="max-w-4xl mx-auto px-4 py-8 sm:px-6 sm:py-12">
      <section class="card">
        <div class="card-body">
          <h1 class="text-2xl font-bold text-heading">Pending users</h1>
          <p class="mt-2 text-sm text-body-secondary">
            Approving a user sends them an email letting them know their account is ready.
          </p>

          <div class="mt-6 space-y-3">
            {success === "approved" && <StatusMessage tone="success" message="User approved and emailed." />}
            {warning === "email_failed" && <StatusMessage tone="warning" message="User approved, but the approval email failed. Follow up manually if needed." />}
            {info === "already_approved" && <StatusMessage tone="info" message="That user was already approved." />}
            {error === "user_not_found" && <StatusMessage tone="error" message="User not found." />}
            {error === "invalid_form" && <StatusMessage tone="error" message="Approval request was invalid." />}
            {error === "failed" && <StatusMessage tone="error" message="Approval failed. Try again." />}
          </div>

          {pendingUsers && pendingUsers.length > 0 ? (
            <ul class="mt-8 divide-y divide-edge" role="list">
              {pendingUsers.map((user) => (
                <li class="flex flex-col gap-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p class="font-semibold text-heading">{user.email}</p>
                    <p class="text-sm text-body-secondary">Timezone: {user.timezone}</p>
                    <p class="text-xs text-muted">Created: {new Date(user.created_at).toLocaleString()}</p>
                  </div>
                  <form action="/api/admin/users/approve" method="post">
                    <input type="hidden" name="user_id" value={user.id} />
                    <button type="submit" class="btn btn-primary">Approve</button>
                  </form>
                </li>
              ))}
            </ul>
          ) : (
            <p class="mt-8 text-body-secondary">No pending users.</p>
          )}
        </div>
      </section>
    </main>
  </div>
</Layout>
```

- [ ] **Step 4: Verify page tests pass**

Run:

```bash
npm test -- tests/pages/pages-render.test.ts
```

Expected: PASS.

## Task 6: Docs and environment declarations

**Files:**

- Modify: `src/types/env.d.ts`
- Modify: `env.example`
- Modify: `README.md`
- Modify: `docs/tooling-setup.md`

- [ ] **Step 1: Update env type declaration**

Modify `src/types/env.d.ts`:

```ts
readonly APPROVAL_ADMIN_EMAILS?: string;
```

Place it near the auth/email env vars:

```ts
readonly EMAIL_FROM: string;
readonly APPROVAL_ADMIN_EMAILS?: string;
readonly UNSUBSCRIBE_TOKEN_SECRET: string;
```

- [ ] **Step 2: Document local `.env.local` value**

Modify `env.example` and the README environment block to include:

```env
# Comma-separated email allowlist for the minimal pending-user approval page.
# Include test@jsolly.com locally if you use the seeded dev-login account.
APPROVAL_ADMIN_EMAILS=test@jsolly.com
```

- [ ] **Step 3: Document production behavior**

In `docs/tooling-setup.md`, under registration approval, add:

```md
User-facing approval emails are sent only when an allowlisted admin approves a
pending user through `/admin/users`. Configure `APPROVAL_ADMIN_EMAILS` as a
comma-separated allowlist. For local development, include `test@jsolly.com`.
Grandfathered users approved by migration and users changed directly in
Supabase Table Editor are not emailed.
```

- [ ] **Step 4: Run docs/type smoke checks**

Run:

```bash
npm run check:ts
npm run check:biome
```

Expected: both commands pass with no errors.

## Task 7: Full verification

**Files:**

- No new source files. Verification only.

- [ ] **Step 1: Run targeted tests**

Run:

```bash
npm test -- \
  tests/lib/auth/approval-admin.test.ts \
  tests/lib/auth/approval-user-email.test.ts \
  tests/lib/auth/approve-user.test.ts \
  tests/api/admin/users/approve.test.ts \
  tests/pages/pages-render.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run full checks**

Run:

```bash
npm run check:biome
npm run check:ts
npm test
```

Expected: PASS. `check:ts` may print existing warnings, but it must report `0 errors`.

- [ ] **Step 3: Optional local browser smoke**

If you want to manually verify the flow:

1. Ensure `.env.local` contains `APPROVAL_ADMIN_EMAILS=test@jsolly.com`.
2. Run `npm run db:reset`.
3. Run `npm run dev`.
4. Sign in as `test@jsolly.com`.
5. Open `http://localhost:4321/admin/users`.
6. Register a new account in a separate browser/session.
7. Confirm the pending user appears, approve them, and inspect Mailpit at `http://127.0.0.1:54324` for the approval email.

## Self-Review

- Spec coverage: The plan covers admin allowlist, `/admin/users`, approve API, approval email, email-failure warning, already-approved idempotency, local `test@jsolly.com` admin configuration, and silent migration grandfathering.
- Placeholder scan: No placeholder markers, "similar to", or unspecified implementation steps remain.
- Type consistency: The helper names are consistent across tasks: `isApprovalAdminEmail`, `sendUserApprovalEmail`, and `approvePendingUser`.
