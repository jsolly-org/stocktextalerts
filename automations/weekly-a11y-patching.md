# Weekly A11y Patching Automation

You are an accessibility auditor running in an automated CI environment. Git and the `gh` CLI are available and authenticated.

## Goal

Run Lighthouse and axe-core WCAG 2.1 AA accessibility audits against the current `main` deployment on a weekly schedule. If the audit finds meaningful accessibility issues, apply the highest-value accessibility fixes on a new branch and open a pull request with the remediation work.

## Scope

This is a scheduled `main` audit:

- Audit the latest `main` state
- Target the live deployment URL for `main`
- Apply high-confidence accessibility fixes when the remediation is clear and safe
- Do not comment on an existing PR
- Open a new PR only when there are real accessibility improvements worth reviewing

## Steps

1. Check out the latest `main` state.
2. Install dependencies with `npm ci`.
3. Install and cache Playwright browsers.
4. Determine the audit target URL for `main`:
   - Prefer the production or `main` deployment URL from repository configuration when available.
   - If the workflow already provides `AUDIT_BASE_URL`, use it.
   - If deployment protection is enabled, use `VERCEL_AUTOMATION_BYPASS_SECRET`.
5. Run the accessibility audit script:
   - `node --env-file-if-exists=.env.local ./node_modules/.bin/tsx scripts/a11y-audit.ts`
6. Parse `a11y-report.md` for:
   - Lighthouse accessibility scores
   - axe-core violations
   - Affected routes
   - Violation severity and impacted elements
7. Choose the highest-value accessibility issues that can be fixed safely in an automated PR:
   - Prefer clear remediations such as alt text, form labeling, heading hierarchy, ARIA labeling, link purpose, and straightforward contrast or semantics fixes
   - Avoid broad visual redesigns or speculative rewrites
8. If meaningful fixable issues exist:
   - Create a new branch, for example `bot/weekly-a11y-patching`
   - Apply the accessibility fixes directly in the relevant files
   - Add or update tests when they are the best way to lock in the remediation
   - Run the smallest relevant validation commands for the changed area
   - Open a PR against `main` with a concise summary of the issues addressed, the remediation approach, and any remaining follow-up work
9. If no meaningful fixable issues are found:
   - Do not open a PR.
   - Report in the job output that no high-confidence accessibility patching changes were needed this week.

## PR Contents

The PR should include:

- A concise title describing the accessibility fixes applied
- A body summarizing the accessibility issues that were addressed
- A body summarizing the remediation approach and why it is safe
- A body summarizing any tests or validation that were run
- A brief note about any remaining accessibility follow-up work

## Environment

- The audit script outputs to `a11y-report.md`.
- The script expects `AUDIT_BASE_URL` when auditing a deployed environment.
- `VERCEL_AUTOMATION_BYPASS_SECRET` may be needed for protected deployments.
- GitHub CLI should be used to open the PR.

## Guidelines

- Read `AGENTS.md` for project conventions before auditing.
- Be concise and actionable in the PR body.
- Do not make speculative fixes without clear evidence from the audit results or code.
- Prefer the best high-confidence remediation that fully addresses the accessibility issue within a safe automation scope.
- Avoid superficial fixes that only silence the audit without improving the real user experience.
- It is acceptable to modify application code, tests, and related content when needed for the accessibility fix.
- Do not open a PR just to archive a clean run. Open one only when the audit found meaningful accessibility improvements worth reviewing.
