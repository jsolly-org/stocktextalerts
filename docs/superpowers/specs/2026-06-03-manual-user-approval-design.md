# Manual user approval

**Status:** Approved

**Date:** 2026-06-03

## Summary

Registration is open, but new accounts are pending by default. Users can create
an account and verify their email, but they cannot access the dashboard or
authenticated APIs until an operator manually approves their `users` row in
Supabase.

The app sends a best-effort admin email to `EMAIL_FROM` when a new profile is
created. There is no shared registration password and no registration rate cap.

## Goals

- Allow public account registration when `REGISTRATION_ENABLED` is `true`.
- Create new users with `approved_at = null`.
- Prevent users from setting or changing their own approval fields.
- Redirect unapproved signed-in users to `/auth/pending-approval`.
- Reject unapproved users from authenticated API routes.
- Email the admin when a new user is waiting for approval.

## Non-goals

- No shared invite or secret password.
- No registration rate limiting.
- No in-app admin approval page for v1.

## Approval model

The `users` table stores:

- `approved_at timestamptz null`
- `approved_by text null`

Manual approval is done in Supabase by setting `approved_at` and `approved_by`.
A database trigger blocks non-service-role inserts or updates that try to set or
change those fields, so users cannot self-approve through the public API.

## Runtime behavior

Registration keeps the existing email/password/timezone flow. After the `users`
profile row is created, the app sends a best-effort admin notification email.
Email failures are logged but do not roll back registration.

Sign-in succeeds at the Supabase Auth layer, but unapproved users are redirected
to `/auth/pending-approval` after cookies are set. Dashboard and profile pages
also redirect unapproved users to the pending page. Authenticated API routes use
the shared user service, which requires approval by default.
