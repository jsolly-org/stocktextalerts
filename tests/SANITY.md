# Manual SANITY Test Plan (Production)

Goal: validate all major happy-path features with the shortest possible flow.

## Prerequisites
- Test email inbox you control (and can receive verification + digest emails)
- Test phone number that can receive SMS (and you can reply to)
- Access to the production site, hCaptcha available
- Ability to wait a few minutes for the daily digest

### Test: User can register for a new account

Step 1: Open the homepage and start registration. Use a new email + strong password, complete hCaptcha, and submit.
- [ ] You are redirected to an unconfirmed/email confirmation screen with verification instructions.
- [ ] A confirmation email arrives in your inbox.

Step 2: Click the confirmation link in the email you received.
- [ ] You are directed to the successful email confirmation page.
- [ ] You end in an authenticated session, or you are prompted to sign in.

Step 3: If you are prompted to log in (or if you signed out), enter the credentials used during registration and sign in.
- [ ] You are redirected to `/dashboard`.
- [ ] The session is authenticated (dashboard is accessible).

### Test: User can configure timezone and notification preferences and the settings are persisted

Step 1: On the dashboard, confirm timezone detection (or select one manually). Save, then refresh.
- [ ] Timezone is set correctly (detected or manual selection is reflected).
- [ ] Timezone persists after refresh.

### Test: User can add stocks to track

Step 1: On the dashboard, search for a common symbol (e.g., AAPL) and add 2-3 stocks.
- [ ] Added stocks appear in the tracked list.
- [ ] Tracked stocks persist after refresh.

### Test: User can enable email notifications and receive notifications

Step 1: On the dashboard, confirm Email notifications are enabled.
- [ ] Email notifications are turned on/enabled on the dashboard.

Step 2: Set the daily digest time to 1 minute in the future (e.g., if it’s 10:34 now, set it to 10:35). Save, then refresh.
- [ ] Daily digest time persists after refresh.

Step 3: Wait 2-3 minutes and check your email inbox.
- [ ] Daily digest email arrives.
- [ ] The email digest includes your tracked symbols.
- [ ] The email digest reflects the chosen digest time/timezone.

### Test: User can enable SMS notifications and receive notifications

Step 1: Enable SMS notifications. Enter a phone number, request a verification code, then enter the code from the SMS.
- [ ] SMS verification succeeds.
- [ ] SMS notifications are enabled (toggle remains on).

Step 2: Change the daily digest time again to 1 minute in the future. Save, then refresh.
- [ ] Daily digest time persists after refresh.

Step 3: Wait 2-3 minutes and check both email and SMS.
- [ ] Daily digest email arrives.
- [ ] Daily digest SMS arrives.
- [ ] Both digests include your tracked symbols.
- [ ] Both digests reflect the chosen digest time/timezone.

Step 4: From the digest email, click the unsubscribe link. Confirm the page indicates success. Return to the dashboard and confirm Email notifications are disabled, then re-enable Email notifications.
- [ ] Unsubscribe page indicates success.
- [ ] Email notifications are turned off/disabled on the dashboard after unsubscribing.
- [ ] Email notifications can be re-enabled from the dashboard.

Step 5: Change password. Sign out and sign back in with the new password. Update email to a new alias you control, then verify it from the inbox.
- [ ] Password change allows sign-out and re-sign-in with the new password.
- [ ] Email update requires verification and the new address can be verified.

Step 6: Use the account deletion action and confirm deletion. Then try to access the dashboard again.
- [ ] Account deletion signs you out.
- [ ] Authenticated pages (e.g., `/dashboard`) are no longer accessible.

### Test: User can use inbound SMS keywords to manage notifications

Step 1: Reply `HELP` to the inbound SMS thread and read the response.
- [ ] `HELP` returns the help response (keywords + dashboard link).

Step 2: Reply `STOP` to the inbound SMS thread and read the response. Then go to the dashboard and confirm your SMS notifications are disabled.
- [ ] `STOP` returns an opt-out acknowledgment.
- [ ] SMS notifications are turned off/disabled on the dashboard.

Step 3: Reply `START` to the inbound SMS thread and read the response. Then go to the dashboard and confirm your SMS notifications are still disabled.
- [ ] A response is sent that you cannot re-enable SMS notifications by replying `START`, and it includes a link to your dashboard.
- [ ] SMS notifications are still turned off/disabled on the dashboard.
