# Manual SANITY Test Plan (Production)

Goal: validate all major happy-path features with the shortest possible flow.

## Preflight
- Test email inbox you control (and can receive verification + digest emails)
- Test phone number that can receive SMS (and you can reply to)
- Access to the production site, hCaptcha available
- Known upcoming time window to wait for the daily digest (can be up to 60 minutes)

## Primary Flow (Happy Path)
- [ ] Open the homepage and start registration.
  - Use a new email + strong password, complete hCaptcha, submit.
  - Land on the unconfirmed screen with instructions to verify.
- [ ] Verify the email from the inbox and confirm you land on the verified page.
  - If prompted, sign in with the new credentials.
  - Email verification succeeds and account is authenticated.
- [ ] On the dashboard, configure preferences while adding stocks.
  - Confirm timezone detection or select a timezone manually.
  - Set daily digest time to the next upcoming hour (to minimize waiting).
  - Search for a common symbol (e.g., AAPL) and add 2-3 stocks.
  - Keep Email notifications enabled.
  - Timezone and digest time persist; stocks appear in the tracked list.
- [ ] Enable SMS notifications.
  - Add a phone number, request a verification code, enter the SMS code.
  - SMS verification succeeds and the SMS toggle is enabled.
- [ ] Wait for the daily digest to arrive.
  - One email and one SMS arrive at the configured time.
  - Both include the tracked symbols and show the chosen digest time.
- [ ] Validate SMS keyword handling (opt-out + resume).
  - Reply "HELP" and confirm the help response.
  - Reply "STOP" and confirm opt-out acknowledgment.
  - Reply "START" and confirm opt-in acknowledgment.
  - HELP/STOP/START keywords behave as expected.
- [ ] Validate email unsubscribe and re-enable.
  - From the digest email, click the unsubscribe link.
  - Confirm the unsubscribe page indicates success.
  - Return to the dashboard and re-enable Email notifications.
  - Email unsubscribe and re-enable flows work.
- [ ] Update profile settings.
  - Change password, sign out, then sign back in with the new password.
  - Update email to a new alias you control and confirm the verification email.
  - Password update works; email update requires re-verification.
- [ ] Delete the account (final step).
  - Use the account deletion action and confirm you are signed out.
  - Account deletion removes access and ends the session.
