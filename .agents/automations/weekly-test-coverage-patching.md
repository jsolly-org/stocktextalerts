# Weekly Test Coverage Patching Automation

You are operating in the repository as a bot agent with Git and GitHub CLI available and authenticated.

## Goal
Analyze the current `main` state on a weekly schedule for meaningful test coverage gaps. Identify real-world scenarios that matter in production but do not appear to have corresponding automated coverage. Add high-value tests for those gaps on a new branch and open a pull request with the coverage improvements.

## Approach - scenario-first, not file-first
Do NOT think "which source files lack test coverage?" Instead, think about what actually happens in this system and whether those scenarios are tested.

## Scope
This is a scheduled `main` coverage patching run:
- Review the latest `main` state
- Add tests for meaningful production scenarios that appear under-covered
- Do not comment on an existing PR
- Open a new PR only when there are worthwhile coverage improvements to add

## Steps
1. Check out the latest `main` state.
2. Read `AGENTS.md` and the `.agents/` directory, especially `.agents/testing.md`, to understand conventions.
3. Explore the source code in `src/` to understand:
   - What users do, such as sign up, track assets, manage notification preferences, and receive alerts
   - What cron jobs do, such as fetch market data, compute digests, detect anomalies, and send notifications
   - What the notification pipeline looks like, including scheduling, timezone handling, format preferences, and delivery
   - What external integrations exist, such as Twilio SMS, AWS SES email, and Finnhub market data
4. Read existing test files in `tests/` to understand what scenarios are already covered.
5. Identify the highest-value missing scenarios on `main`:
   - User journeys
   - System events
   - Business logic paths
   - Data integrity flows
6. Choose the best gaps to cover:
   - Prefer plausible production scenarios
   - Prefer gaps that could cause user-visible regressions or silent data problems
   - Favor a small number of meaningful tests over broad low-signal coverage
7. Add tests for the selected gaps:
   - Use Vitest only
   - Prefer scenario-based integration tests over isolated unit tests
   - Reuse helpers from `tests/helpers/`
   - Use realistic tickers, prices, timezones, and user data
   - Name tests like real production scenarios, not function behaviors
8. Optionally run the smallest relevant test commands for signal:
   - Prefer targeted test files first using `npm test -- <path-to-test-file>`
   - If multiple related files were changed, run the relevant subset
   - Do not weaken assertions, add unrealistic mocks, or change production behavior just to make the tests pass
   - If a new test fails because it exposed a real missing behavior or regression, keep the test and document the failure clearly in the PR
9. If meaningful coverage improvements were added:
   - Create a branch, for example `bot/weekly-test-coverage-patching`
   - Commit the new or updated test files
   - Open a PR against `main` using GitHub CLI
10. If no meaningful test gaps are found:
   - Do not open a PR
   - Report in the job output that the most important production scenarios appear to be covered

## PR Contents
The PR should include:
- A concise title describing the scenarios now covered
- A body summarizing which production scenarios were missing coverage
- A body summarizing which tests were added
- A body summarizing why these scenarios were high priority
- A note about whether the new tests were run, and if so, whether any are currently failing because they expose real bugs or unfinished behavior

If you found additional worthwhile gaps but did not cover them in this PR, mention them briefly in the PR body as follow-up ideas.

## Rules
- You may modify `tests/` and shared test helpers when needed for the new coverage.
- Do not modify production code in `src/` just to make the new tests pass. This automation's job is to add missing coverage, not to fix all exposed bugs immediately.
- Never hard-code behavior, weaken assertions, or add unrealistic mocks just to produce passing tests.
- If the new tests reveal a real bug or missing implementation, it is acceptable to open the PR with those tests failing as long as the PR clearly explains the current failure and why the test is still valuable.
- Do not add tests just to create activity. Only add tests for meaningful production scenarios.
- Do not create issues.
