# Manual SANITY Test Plan (Production)

**Version:** 2.0
**Application:** StockTextAlerts
**Environment:** Production
**Test Type:** Sanity / Smoke (Manual)

---

## Executive Summary

Validate all major happy-path features end-to-end on production with the shortest possible flow. This plan covers registration, stock tracking, email/SMS notifications, profile management, inbound SMS keywords, and account deletion.

**Estimated Duration:** 30-45 minutes (includes wait time for digest delivery)

---

## Prerequisites

- [ ] Test email inbox you control (and can receive verification + digest emails)
- [ ] A second email alias you control (for email update test)
- [ ] Test phone number that can receive SMS (and you can reply to)
- [ ] Access to the production site
- [ ] Modern browser (Chrome, Firefox, or Safari)
- [ ] hCaptcha solver available (not in a headless/bot environment)
- [ ] Ability to wait a few minutes for the daily digest

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

**Step 1:** Open the homepage and click the registration CTA. Enter a new email + strong password, complete hCaptcha, and submit.

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
- Registration requires hCaptcha; automated scripts cannot bypass this.

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

## TC-STK-001: User can add stocks to track

**Priority:** P0 (Critical)
**Type:** Functional
**Estimated Time:** 2 minutes

### Objective

Verify stock search, selection, and persistence.

### Preconditions

- Authenticated session on `/dashboard`

### Test Steps

**Step 1:** On the dashboard, use the stock search field. Search for a common symbol (e.g., "AAPL") and add 2-3 stocks.

- [ ] Search results appear as you type (fuzzy search works).
- [ ] Added stocks appear in the tracked list immediately.
- [ ] A save/success indicator confirms the stocks were saved.

**Step 2:** Hard-refresh the page.

- [ ] Tracked stocks persist after refresh (same stocks displayed).

### Notes

- Max 10 stocks per user. Symbols should display in uppercase.

---

## TC-EMAIL-001: User can enable email notifications and receive a digest

**Priority:** P0 (Critical)
**Type:** Functional / Integration
**Estimated Time:** 5 minutes (including wait)

### Objective

Verify email notification toggle, digest time scheduling, and email delivery.

### Preconditions

- Authenticated session on `/dashboard`
- At least 2-3 stocks tracked (from TC-STK-001)

### Test Steps

**Step 1:** On the dashboard, confirm Email notifications are enabled (toggle is on).

- [ ] Email notifications are turned on/enabled on the dashboard.

**Step 2:** Set the daily digest time to 1 minute in the future (e.g., if it's 10:34 now, set it to 10:45 — the next 15-minute interval). Save, then refresh.

- [ ] Daily digest time persists after refresh.
- [ ] A countdown to the next notification is displayed.

**Step 3:** Wait 2-3 minutes and check your email inbox.

- [ ] Daily digest email arrives.
- [ ] The email includes your tracked stock symbols with current prices and daily change percentages.
- [ ] Positive changes display in green; negative changes display in red.
- [ ] If sent outside market hours, a "Prices as of last market close." disclaimer is visible.
- [ ] The email reflects the chosen digest time/timezone.

### Notes

- Digest times are in 15-minute intervals. Choose the nearest upcoming interval.
- The cron runs every 15 minutes, so delivery may take up to 15 minutes.

---

## TC-SMS-001: User can enable SMS notifications and receive a digest

**Priority:** P0 (Critical)
**Type:** Functional / Integration
**Estimated Time:** 8 minutes (including wait)

### Objective

Verify phone verification, SMS toggle, and SMS digest delivery.

### Preconditions

- Authenticated session on `/dashboard`
- At least 2-3 stocks tracked
- Email notifications already enabled (from TC-EMAIL-001)

### Test Steps

**Step 1:** Enable SMS notifications. Enter a phone number, request a verification code, then enter the 6-digit code from the SMS.

- [ ] Verification code SMS arrives on your phone.
- [ ] SMS verification succeeds after entering the code.
- [ ] SMS notifications are enabled (toggle remains on after save).

**Step 2:** Change the daily digest time again to a time 1 minute in the future (next 15-minute interval). Save, then refresh.

- [ ] Daily digest time persists after refresh.

**Step 3:** Wait 2-3 minutes and check both email and SMS.

- [ ] Daily digest email arrives.
- [ ] Daily digest SMS arrives.
- [ ] Both digests include your tracked stock symbols with current prices and daily change percentages.
- [ ] If sent outside market hours, a "Prices as of last market close." disclaimer is visible in both email and SMS.
- [ ] Both digests reflect the chosen digest time/timezone.

### Notes

- SMS messages may span multiple segments for users tracking many stocks. Each stock is listed on its own line with price data.
- SMS includes "Reply STOP to opt out" compliance text.

---

## TC-UNSUB-001: User can unsubscribe from email via unsubscribe link

**Priority:** P1 (High)
**Type:** Functional
**Estimated Time:** 2 minutes

### Objective

Verify the email unsubscribe flow and dashboard state synchronization.

### Preconditions

- A digest email received (from TC-SMS-001 Step 3)
- Authenticated session available

### Test Steps

**Step 1:** From the digest email, click the unsubscribe link.

- [ ] Unsubscribe page loads and indicates success.

**Step 2:** Return to the dashboard and check the Email notifications toggle.

- [ ] Email notifications are turned off/disabled on the dashboard.

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

- Account deletion is permanent and cascades to all related data (stocks, preferences, notifications).

---

## TC-INBOUND-001: User can use inbound SMS keywords to manage notifications

**Priority:** P1 (High)
**Type:** Functional / Integration
**Estimated Time:** 5 minutes

### Objective

Verify HELP, STOP, and START SMS keyword handling and dashboard state synchronization.

### Preconditions

- SMS notifications previously enabled (requires a separate test account or re-registration since TC-DEL-001 deletes the account)
- Access to the phone that received SMS digests

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
- The STOP/START behavior follows Twilio's compliance requirements.

---

## Test Execution Order

The tests above are designed to run sequentially in a single session:

| Order | Test ID | Description | Depends On |
|-------|---------|-------------|------------|
| 1 | TC-REG-001 | Register new account | - |
| 2 | TC-TZ-001 | Configure timezone | TC-REG-001 |
| 3 | TC-STK-001 | Add tracked stocks | TC-REG-001 |
| 4 | TC-EMAIL-001 | Enable email + receive digest | TC-STK-001 |
| 5 | TC-SMS-001 | Enable SMS + receive digest | TC-STK-001, TC-EMAIL-001 |
| 6 | TC-UNSUB-001 | Unsubscribe via email link | TC-SMS-001 |
| 7 | TC-PROF-001 | Change password + update email | TC-REG-001 |
| 8 | TC-DEL-001 | Delete account | TC-REG-001 |
| 9 | TC-INBOUND-001 | Inbound SMS keywords | Separate account with SMS enabled |

> **Note:** TC-INBOUND-001 requires an account with active SMS notifications. Since TC-DEL-001 deletes the account, either run TC-INBOUND-001 before TC-DEL-001 (between steps 6 and 7), or use a separate test account.

---

## Pass / Fail Criteria

**PASS:** All checkboxes marked. No critical or high-severity bugs found.

**FAIL (block release):**
- Any TC-REG, TC-STK, TC-EMAIL, or TC-SMS test fails (P0 tests)
- Digest email or SMS never arrives
- Account cannot be created or deleted
- Security issue discovered (e.g., dashboard accessible after deletion)

**CONDITIONAL:**
- Minor UI inconsistencies (e.g., timezone display quirks)
- Non-blocking warnings in the console
- Digest arrives but with minor formatting issues

---

## Known Considerations

- hCaptcha may behave differently across browsers/regions.
- Twilio SMS delivery can have carrier-dependent delays.
- Cron runs every 15 minutes, so digest delivery is not instantaneous.
- SMS messages may span multiple segments when tracking many stocks with price data.
- Email updates via Supabase Auth may require verifying both old and new addresses depending on configuration.
