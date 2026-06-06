# Remove Confirm Password Fields Implementation Plan

**Spec:** No separate spec; request is to remove password confirmation from signup, profile password change, and password reset.

**Goal:** All password-entry flows collect one password field, relying on password managers and browser/native validation instead of asking users to type passwords twice.

**Architecture:** Keep each existing flow and endpoint in place. Remove only the redundant `confirm` form field, client-side match feedback, server-side mismatch validation, and tests that assert mismatch behavior.

**Tech Stack:** Astro pages, server API routes, Supabase Auth, Vitest, Playwright.

---

## Review Findings Incorporated

- The previous plan lived under `.cursor/plans/`; this canonical copy is in `docs/superpowers/plans/` per repo convention.
- The previous markdown had malformed link formatting such as `` `**[file](file)`:** ``; this plan uses normal path references.
- The previous "optional" render regression check should be included in the implementation because it is cheap and directly protects this behavior.
- The cleanup scope is correct: remove `password_mismatch` only after all three APIs stop emitting it.

## Files

- Modify [`src/pages/auth/register.astro`](../../../src/pages/auth/register.astro): remove signup confirm field and match-feedback script.
- Modify [`src/pages/api/auth/email/register.ts`](../../../src/pages/api/auth/email/register.ts): remove `confirm` parsing and mismatch branch.
- Modify [`src/components/profile/AccountManagement.astro`](../../../src/components/profile/AccountManagement.astro): remove profile confirm field and simplify submit enablement.
- Modify [`src/pages/api/auth/change-password.ts`](../../../src/pages/api/auth/change-password.ts): remove `confirm` parsing and mismatch branch.
- Modify [`src/pages/auth/recover.astro`](../../../src/pages/auth/recover.astro): remove reset confirm field and match-feedback script.
- Modify [`src/pages/api/auth/update-password.ts`](../../../src/pages/api/auth/update-password.ts): remove `confirm` parsing and mismatch branch.
- Modify [`src/lib/constants.ts`](../../../src/lib/constants.ts): remove now-unused `password_mismatch`.
- Modify auth API and E2E tests listed below.
- Modify [`tests/pages/pages-render.test.ts`](../../../tests/pages/pages-render.test.ts): add render-level regression assertions that password pages no longer contain `name="confirm"`.

## Task 1: Signup Flow

**Files:** [`src/pages/auth/register.astro`](../../../src/pages/auth/register.astro), [`src/pages/api/auth/email/register.ts`](../../../src/pages/api/auth/email/register.ts), signup tests.

- [ ] Remove the confirm-password `<div>` from `register.astro`.
- [ ] Keep the script import for `DEFAULT_TIMEZONE` and `setupDetectedTimezoneOption`, but drop `MIN_PASSWORD_LENGTH` from that script import if it is no longer used there.
- [ ] Delete the signup match-feedback IIFE that reads `#confirm`, `#confirm-match-feedback`, `#confirm-match-icon`, and `#confirm-match-text`.
- [ ] In `email/register.ts`, change the parsed schema to:

```ts
const parsed = parseWithSchema(formData, {
 email: { type: "string", required: true },
 password: { type: "string", required: true, trim: false },
 timezone: { type: "timezone" },
} as const);
```

- [ ] Destructure only `email`, `password`, and `timezone`.
- [ ] Delete the `password !== confirm` branch and its log line.
- [ ] Update signup tests:
  - [`tests/api/auth/email/register.security.test.ts`](../../../tests/api/auth/email/register.security.test.ts): remove mismatch test; remove `confirm` from weak-password payload.
  - [`tests/api/auth/email/register.test.ts`](../../../tests/api/auth/email/register.test.ts): remove `confirm` from `buildRegistrationPayload`.
  - [`tests/api/auth/email/register.gate.test.ts`](../../../tests/api/auth/email/register.gate.test.ts): remove `confirm` from request body.
  - [`tests/e2e/sanity.e2e.spec.ts`](../../../tests/e2e/sanity.e2e.spec.ts): remove signup `#confirm` fill.
  - [`tests/e2e/registration-approval.e2e.spec.ts`](../../../tests/e2e/registration-approval.e2e.spec.ts): remove signup `#confirm` fill.

## Task 2: Profile Password Change

**Files:** [`src/components/profile/AccountManagement.astro`](../../../src/components/profile/AccountManagement.astro), [`src/pages/api/auth/change-password.ts`](../../../src/pages/api/auth/change-password.ts), profile password tests.

- [ ] Remove the confirm-password `<div>` from the profile password form.
- [ ] Change the new-password input `aria-describedby` from `password-change-help password-match-feedback` to `password-change-help`.
- [ ] Simplify the profile password script so it only requires `#new-password`, `#save-password-btn`, and `data-min-length`.
- [ ] Disable the submit button when `password.length < minLength`; no mismatch logic remains.
- [ ] In `change-password.ts`, parse only `password`:

```ts
const parsed = parseWithSchema(formData, {
 password: { type: "string", required: true, trim: false },
} as const);
```

- [ ] Destructure only `password`.
- [ ] Delete the `password !== confirm` branch and its log line.
- [ ] Update profile password tests:
  - [`tests/api/auth/change-password.test.ts`](../../../tests/api/auth/change-password.test.ts): remove `confirm` from success and weak-password payloads; delete mismatch test.
  - [`tests/api/auth/change-password.security.test.ts`](../../../tests/api/auth/change-password.security.test.ts): remove `confirm` from payloads; incomplete-form test should send only an invalid or empty `password`.
  - [`tests/e2e/sanity.e2e.spec.ts`](../../../tests/e2e/sanity.e2e.spec.ts): remove skipped profile test's `#confirm-password` fill so it stays accurate when re-enabled.

## Task 3: Password Reset

**Files:** [`src/pages/auth/recover.astro`](../../../src/pages/auth/recover.astro), [`src/pages/api/auth/update-password.ts`](../../../src/pages/api/auth/update-password.ts), reset tests.

- [ ] Remove the confirm-password `<div>` from `recover.astro`.
- [ ] Delete the entire recover-page match-feedback `<script>` block; after removing confirm feedback, that page has no remaining client script.
- [ ] In `update-password.ts`, parse only `password` and `token_hash`:

```ts
const parsed = parseWithSchema(formData, {
 password: { type: "string", required: true, trim: false },
 token_hash: { type: "string", required: true },
} as const);
```

- [ ] Destructure only `password` and `token_hash: tokenHash`.
- [ ] Delete the `password !== confirm` branch and its `password_mismatch` redirect.
- [ ] Update reset tests:
  - [`tests/api/auth/update-password.test.ts`](../../../tests/api/auth/update-password.test.ts): remove `confirm` from success and weak-password payloads; delete mismatch test.
  - [`tests/api/auth/update-password.security.test.ts`](../../../tests/api/auth/update-password.security.test.ts): remove `confirm` from the incomplete-form payload.

## Task 4: Cleanup and Regression Guards

- [ ] In [`src/lib/constants.ts`](../../../src/lib/constants.ts), remove `password_mismatch: "Passwords do not match."`.
- [ ] In [`tests/pages/pages-render.test.ts`](../../../tests/pages/pages-render.test.ts), extend the existing register render test or add a focused test:

```ts
expect(html).not.toContain('name="confirm"');
```

- [ ] Add a recover render assertion using a recovery-shaped URL:

```ts
const response = await container.renderToResponse(AuthRecoverPage, {
 request: buildRequest("/auth/recover?token_hash=test-token&type=recovery"),
});
const html = await response.text();
expect(html).toContain('name="password"');
expect(html).not.toContain('name="confirm"');
```

- [ ] After edits, run a targeted search and ignore unrelated `email_confirm`, `email_confirmed_at`, and timezone mismatch names:

```bash
rg 'password_mismatch|name="confirm"|confirm-password|Passwords match|Passwords do not match' src tests
```

Expected: no matches related to password-confirm functionality.

## Verification

- [ ] Run targeted auth tests:

```bash
npm test -- tests/api/auth/email/register.test.ts tests/api/auth/email/register.security.test.ts tests/api/auth/email/register.gate.test.ts tests/api/auth/change-password.test.ts tests/api/auth/change-password.security.test.ts tests/api/auth/update-password.test.ts tests/api/auth/update-password.security.test.ts tests/pages/pages-render.test.ts
```

Expected: all listed test files pass.

- [ ] Run project checks:

```bash
npm run check:ts
npm run check:biome
```

Expected: both commands pass.

## Manual Checks

- `/auth/register` shows email, password, and timezone only.
- `/profile` signed in shows one "New password" field under Change password.
- `/auth/recover?token_hash=...&type=recovery` shows one new-password field.

## Explicit Non-Goals

- Do not add a current-password field to profile change in this work.
- Do not touch Supabase `email_confirm` / `email_confirmed_at`.
- Do not touch timezone mismatch code.
- Do not remove `src/icons/check-circle-20.svg`; it is still used by SMS verification UI.
- Do not add a shared password-match helper; the matching behavior is being deleted.
