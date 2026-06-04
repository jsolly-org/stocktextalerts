# Weekly Code Improvements Automation

You are operating in the repository with Git and the GitHub CLI available and authenticated.

## Goal

Improve code quality on the current `main` state on a weekly schedule:

- Find and fix dead code, unused imports or exports, lint issues, and other code quality problems
- Reduce duplication, lower complexity, improve type safety, and clean up code structure
- Look for practical performance improvements such as slow queries, unnecessary re-renders, bundle size problems, and opportunities to use static or precomputed values

## Scope

This is a scheduled `main` improvement run:

- Review the latest `main` state
- Apply meaningful code quality and performance improvements directly in a branch
- Do not comment on an existing PR
- Open a new PR only when there are worthwhile improvements to review

## Instructions

1. Check out the latest `main` state.
2. Read `AGENTS.md` for project conventions and guidelines.
3. Analyze the codebase for quality issues across the files most likely to benefit from cleanup.
4. Choose improvements that are high-value, safe, and reasonably scoped for an automated PR:
   - Prefer changes that simplify the codebase or remove real maintenance burden
   - Prefer improvements with clear evidence, such as dead code, duplication, lint noise, or obviously wasteful work
   - Avoid broad speculative refactors without a clear payoff
5. Make the improvements directly in the files.
6. Run the smallest relevant validation commands for the changed area:
   - Use `npm run check:biome` for formatting and linting when relevant
   - Use `npm run check:ts` when TypeScript-affected code changed
   - Run targeted tests when behavior changed or when tests are needed to lock in the improvement
7. If meaningful improvements were made:
   - Create a branch, for example `bot/weekly-code-improvements`
   - Commit the changes
   - Open a PR against `main` using GitHub CLI
8. If no worthwhile improvements are found:
   - Do not open a PR
   - Report in the job output that no meaningful code improvements were identified this week

## Improvement Priorities

- Remove dead code, stale helpers, unused imports, and unused exports when they are truly no longer needed
- Simplify complex control flow or overly abstract code when a clearer design is available
- Reduce duplication when shared logic can be extracted without making the code harder to follow
- Improve type safety where weak typing is hiding real mistakes or making the code harder to maintain
- Address performance issues that have a plausible user or operational impact

## PR Contents

The PR should include:

- A concise title describing the code improvements applied
- A body summarizing the main quality or performance issues addressed
- A body summarizing why the chosen changes were worthwhile
- A body summarizing any validation or tests that were run
- A brief note about any follow-up improvements that were identified but left out of scope

## Rules

- Ensure all changes follow the project's coding standards and conventions.
- Prefer simpler designs over preserving unnecessary legacy structure.
- Do not make speculative changes without clear evidence they improve quality, maintainability, or performance.
- Avoid cosmetic churn that does not materially improve the codebase.
- It is acceptable to modify application code, tests, configuration, and related files when needed for the improvement.
- Do not create issues.
