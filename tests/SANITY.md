# Manual SANITY Test Plan (Production)

**Version:** 2.0
**Application:** StockTextAlerts
**Environment:** Production
**Test Type:** Sanity / Smoke (Manual)

---

## Executive Summary

Validate all major happy-path features end-to-end on production with the shortest possible flow. This plan covers registration, asset tracking, email/SMS notifications, profile management, inbound SMS keywords, and account deletion.

**Estimated Duration:** 15-30 minutes (cron runs every minute)

---

## Prerequisites

- [ ] Record the run metadata somewhere (helps debugging):
  - [ ] Production URL
  - [ ] Date/time started (and your timezone)
  - [ ] Browser + version
  - [ ] Test email + phone used
- [ ] Test email inbox you control (and can receive verification + notification emails)
- [ ] A second email alias you control (for email update test)
- [ ] Test phone number that can receive SMS (and you can reply to)
- [ ] Access to the production site
- [ ] Modern browser (Chrome, Firefox, or Safari)
- [ ] Ability to wait a few minutes for the scheduled notification

---

## TC-REG-001: User can register for a new account

**Priority:** P0 (Critical)
**Type:** Functional
**Estimated Time:** 3 minutes

### Objective

Verify new user registration, email confirmation, and first sign-in.

### Preconditions

- A fresh email address not already registered

### Test Steps

**Step 1:** Open the homepage and click the registration CTA. Enter a new email + strong password and submit.

- [ ] You are redirected to the unconfirmed/email confirmation screen (`/auth/unconfirmed`) with verification instructions.
- [ ] A confirmation email arrives in your inbox within 60 seconds.

**Step 2:** Click the confirmation link in the email.

- [ ] You are directed to the successful email confirmation page (`/auth/verified`).
- [ ] You end in an authenticated session, or you are prompted to sign in.

**Step 3:** If prompted to log in, enter the credentials used during registration and sign in.

- [ ] You are redirected to `/dashboard`.
- [ ] The session is authenticated (dashboard content is visible, not a login redirect).

### Notes

- If the confirmation email doesn't arrive, check spam/junk folders.

---

## TC-AUTH-001: User can sign out and sign back in

**Priority:** P0 (Critical)
**Type:** Functional
**Estimated Time:** 2 minutes

### Objective

Verify session termination and sign-in redirect behavior.

### Preconditions

- Authenticated session

### Test Steps

**Step 1:** Sign out.

- [ ] You are signed out successfully.

**Step 2:** Navigate directly to `/dashboard`.

- [ ] You are redirected to sign-in (or otherwise blocked from authenticated content).

**Step 3:** Sign back in with the same credentials.

- [ ] Sign-in succeeds and you end at `/dashboard`.

---

## TC-TZ-001: User can configure timezone and the setting is persisted

**Priority:** P1 (High)
**Type:** Functional
**Estimated Time:** 2 minutes

### Objective

Verify timezone detection/selection persists across page reloads.

### Preconditions

- Authenticated session on `/dashboard`

### Test Steps

**Step 1:** On the dashboard or profile page, confirm timezone detection (or select one manually). Save, then hard-refresh the page (Ctrl+Shift+R / Cmd+Shift+R).

- [ ] Timezone is set correctly (detected or manual selection is reflected).
- [ ] Timezone persists after refresh.

### Notes

- If browser timezone differs from the saved timezone, a mismatch banner should appear prompting the user to update.

---

## TC-AST-001: User can add assets to track

**Priority:** P0 (Critical)
**Type:** Functional
**Estimated Time:** 2 minutes

### Objective

Verify asset search, selection, and persistence.

### Preconditions

- Authenticated session on `/dashboard`

### Test Steps

**Step 1:** On the dashboard, use the asset search field. Search for a common symbol (e.g., "AAPL") and add 2-3 assets.

- [ ] Search results appear as you type (fuzzy search works).
- [ ] Added assets appear in the tracked list immediately.
- [ ] A save/success indicator confirms the assets were saved.

**Step 2:** Hard-refresh the page.

- [ ] Tracked assets persist after refresh (same assets displayed).

### Notes

- Max 10 assets per user. Symbols should display in uppercase.

---

## TC-EMAIL-001: User can enable email notifications and receive an update

**Priority:** P0 (Critical)
**Type:** Functional / Integration
**Estimated Time:** 10-20 minutes (including wait)

### Objective

Verify email notification toggle, notification time scheduling, and email delivery.

### Preconditions

- Authenticated session on `/dashboard`
- At least 2-3 assets tracked (from TC-AST-001)

### Test Steps

**Step 1:** On the dashboard, confirm Email notifications are enabled (toggle is on).

- [ ] Email notifications are turned on/enabled on the dashboard.

**Step 2:** Set the notification time to any minute that is **at least 2 minutes from now**.

- Example: if it's 10:34 now, set it to 10:36.

Save, then refresh.

- [ ] Notification time persists after refresh.
- [ ] A countdown to the next notification is displayed.

**Step 3:** Wait until just after the selected delivery time, then check your email inbox.

- [ ] The update email arrives within ~2 minutes of your selected time (cron runs every minute).

- [ ] Asset update email arrives.
- [ ] The email includes your tracked asset symbols with current prices and change percentages.
- [ ] Positive changes display in green; negative changes display in red.
- [ ] If sent outside market hours, a "Prices as of last market close." disclaimer is visible.
- [ ] The email reflects the chosen notification time/timezone.

### Notes

- Any minute can be selected for notification times.
- The cron runs every minute, so delivery should be near-immediate.

---

## TC-NOTIF-001: Notification preferences persist on reload

**Priority:** P0 (Critical)
**Type:** Functional
**Estimated Time:** 2 minutes

### Objective

Verify that toggling notification preferences persists across page reloads.

### Preconditions

- Authenticated session on `/dashboard`
- Email notifications already enabled (from TC-EMAIL-001)

### Test Steps

**Step 1:** On the dashboard, toggle Email notifications OFF. Hard-refresh the page.

- [ ] Email notifications toggle is OFF after refresh.

**Step 2:** Toggle Email notifications back ON. Hard-refresh the page.

- [ ] Email notifications toggle is ON after refresh.

---

## TC-UNSUB-001: User can unsubscribe from email via unsubscribe link

**Priority:** P1 (High)
**Type:** Functional
**Estimated Time:** 2 minutes

### Objective

Verify the email unsubscribe flow and dashboard state synchronization.

### Preconditions

- A notification email received (from TC-EMAIL-001 Step 3)
- Authenticated session available

### Test Steps

**Step 1:** From the notification email, click the unsubscribe link.

- [ ] Unsubscribe page loads and indicates success.

**Step 2:** Return to the dashboard and check the Email notifications toggle.

- [ ] Email notifications are turned off/disabled on the dashboard (refresh the page if needed).

**Step 3:** Re-enable Email notifications from the dashboard.

- [ ] Email notifications can be re-enabled and the toggle stays on after save.

---

## TC-PROF-001: User can change password and update email

**Priority:** P1 (High)
**Type:** Functional
**Estimated Time:** 5 minutes

### Objective

Verify password change, re-authentication, and email update with verification.

### Preconditions

- Authenticated session on `/profile`
- A second email alias you control

### Test Steps

**Step 1:** On the profile page, change your password to a new strong password. Sign out.

- [ ] Password change confirmation/success message is shown.

**Step 2:** Sign back in using the **new** password.

- [ ] Sign-in succeeds with the new password.
- [ ] You are redirected to `/dashboard`.

**Step 3:** Update your email to a new alias you control, then verify it from the new inbox.

- [ ] Email update triggers a verification email to the new address.
- [ ] The new email address can be verified successfully.

---

## TC-DEL-001: User can delete their account

**Priority:** P1 (High)
**Type:** Functional
**Estimated Time:** 2 minutes

### Objective

Verify account deletion, session termination, and access revocation.

### Preconditions

- Authenticated session on `/profile`

### Test Steps

**Step 1:** Use the account deletion action and confirm deletion.

- [ ] A confirmation prompt appears before deletion.
- [ ] Account deletion signs you out.

**Step 2:** Try to access `/dashboard` directly.

- [ ] Authenticated pages (e.g., `/dashboard`) are no longer accessible.
- [ ] You are redirected to the sign-in page.

### Notes

- Account deletion is permanent and cascades to all related data (assets, preferences, notifications).

---

## TC-INBOUND-001: User can use inbound SMS keywords to manage notifications

**Priority:** P1 (High)
**Type:** Functional / Integration
**Estimated Time:** 5 minutes

### Objective

Verify HELP, STOP, and START SMS keyword handling and dashboard state synchronization.

### Preconditions

- SMS notifications previously enabled (requires a separate test account or re-registration since TC-DEL-001 deletes the account)
- Access to the phone that received SMS notifications

### Test Steps

**Step 1:** Reply `HELP` to the inbound SMS thread and read the response.

- [ ] `HELP` returns the help response (keywords + dashboard link).

**Step 2:** Reply `STOP` to the inbound SMS thread and read the response. Then go to the dashboard and confirm SMS notifications status.

- [ ] `STOP` returns an opt-out acknowledgment.
- [ ] SMS notifications are turned off/disabled on the dashboard.

**Step 3:** Reply `START` to the inbound SMS thread and read the response. Then go to the dashboard and confirm SMS notifications status.

- [ ] A response is sent that you cannot re-enable SMS notifications by replying `START`, and it includes a link to your dashboard.
- [ ] SMS notifications are still turned off/disabled on the dashboard (must re-enable from dashboard).

### Notes

- Keywords are case-insensitive (STOP, stop, Stop all work).
- The STOP/START behavior follows SMS compliance requirements.
- If carrier re-opt-in behavior differs, the product requirement is: **dashboard state remains the source of truth**.

---

## Test Execution Order

The tests above are designed to run sequentially in a single session:

| Order | Test ID | Description | Depends On |
|-------|---------|-------------|------------|
| 1 | TC-REG-001 | Register new account | - |
| 2 | TC-AUTH-001 | Sign out + sign in | TC-REG-001 |
| 3 | TC-TZ-001 | Configure timezone | TC-REG-001 |
| 4 | TC-AST-001 | Add tracked assets | TC-REG-001 |
| 5 | TC-EMAIL-001 | Enable email + receive update | TC-AST-001 |
| 6 | TC-NOTIF-001 | Notification prefs persist on reload | TC-EMAIL-001 |
| 7 | TC-UNSUB-001 | Unsubscribe via email link | TC-NOTIF-001 |
| 8 | TC-PROF-001 | Change password + update email | TC-REG-001 |
| 9 | TC-DEL-001 | Delete account | TC-REG-001 |
| 10 | TC-INBOUND-001 | Inbound SMS keywords | Separate account with SMS enabled |

> **Note:** TC-INBOUND-001 requires an account with active SMS notifications. Since TC-DEL-001 deletes the account, either run TC-INBOUND-001 before TC-DEL-001 (between steps 6 and 7), or use a separate test account.

---

## Pass / Fail Criteria

**PASS:** All checkboxes marked. No critical or high-severity bugs found.

**FAIL (block release):**
- Any TC-REG, TC-AST, TC-EMAIL, or TC-SMS test fails (P0 tests)
- Notification email or SMS never arrives
- Account cannot be created or deleted
- Security issue discovered (e.g., dashboard accessible after deletion)

**CONDITIONAL:**
- Minor UI inconsistencies (e.g., timezone display quirks)
- Non-blocking warnings in the console
- Notification arrives but with minor formatting issues

---

## Known Considerations

- SMS delivery can have carrier-dependent delays.
- Cron runs every minute, so notification delivery should be near-immediate.
- SMS messages may span multiple segments when tracking many assets with price data.
- Email updates via Supabase Auth may require verifying both old and new addresses depending on configuration.

---

## Troubleshooting: scheduled email/SMS never arrives

- [ ] Confirm the delivery time you set is in the expected timezone.
- [ ] Wait at least 2 minutes after the selected time.
- [ ] Verify both Email/SMS toggles are still enabled after refresh.
- [ ] Check spam/junk for email.
- [ ] Try reducing tracked assets to 1-2 to rule out long-message/format issues.
