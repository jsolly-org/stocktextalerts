# Approval email

**Status:** Approved

**Date:** 2026-06-03

## Summary

Approving a pending StockTextAlerts user should send that user a friendly email
letting them know their account is ready. Existing production users remain
grandfathered silently by the manual-approval migration; only approvals made
through the new app-owned admin action send user-facing approval email.

## Goals

- Add a small app-admin approval workflow for pending users.
- Send a user-facing email when an admin approves a pending user.
- Keep grandfathered users silent; no surprise approval emails for existing
  users approved by SQL migration.
- Keep approval email best-effort enough to avoid losing the approval if email
  delivery fails, while surfacing the failure to the admin.
- Allow `test@jsolly.com` to act as an admin in local development via
  configuration.

## Non-goals

- No database trigger that sends email directly.
- No Supabase table-editor approval email automation for v1.
- No broad admin console beyond pending-user approval.
- No role-management UI.

## Admin authorization

Admin access is controlled by an environment allowlist, for example
`APPROVAL_ADMIN_EMAILS`, containing comma-separated email addresses. The server
checks the signed-in user's authenticated email against this list before showing
pending users or approving accounts.

For local development, `test@jsolly.com` should be included in the allowlist so
the seeded dev-login account can approve pending users. This should be
configuration, not a hard-coded privilege in seed data.

## Approval flow

Add a small admin page, likely `/admin/users`, for allowlisted admins. The page
shows users with `approved_at IS NULL`, including safe operational details such
as email, timezone, and created time.

Each pending row has an Approve action that posts to an admin API route. The API
route:

1. Authenticates the current user.
2. Verifies the current user's email is in the admin allowlist.
3. Loads the target pending user.
4. Updates `users.approved_at = now()` and `users.approved_by = <admin email>`
   using the server-side admin Supabase client.
5. Sends a user-facing approval email to the approved user's email address.
6. Returns success if approval succeeded, and includes an admin-visible warning
   if the email send failed.

The update should be idempotent. If the target user is already approved, the API
should not send another approval email and should return a clear "already
approved" result.

## Email behavior

The approval email is sent only by the app admin approval action. SQL migration
backfills and direct Supabase table edits do not send approval email.

Suggested subject:

```text
Your StockTextAlerts account is approved
```

Suggested body:

```text
Your StockTextAlerts account has been approved.

You can now sign in and set up your stock alerts:
<site-url>/auth/signin
```

The email must not include passwords, tokens, or secret links. Delivery uses the
existing `createEmailSender()` path, so local development routes to Mailpit when
SMTP env vars are configured, non-production tests use mocks, and production
uses SES.

## Error handling

Approval is the source-of-truth state change. If the database update succeeds
but email delivery fails, the user remains approved. The API should log the
email failure and show the admin a warning so they can decide whether to follow
up manually.

If the database update fails, do not send email.

## Testing

- Admin allowlist parsing accepts comma-separated emails with whitespace.
- Non-admin signed-in users cannot view pending users or approve accounts.
- Logged-out users are redirected or rejected.
- Approving a pending user sets `approved_at` and `approved_by`.
- Approval sends the user-facing email with the sign-in link.
- Email failure does not roll back approval and returns an admin-visible
  warning.
- Already-approved users are not emailed again.
- `test@jsolly.com` works as a local admin when included in
  `APPROVAL_ADMIN_EMAILS`.
