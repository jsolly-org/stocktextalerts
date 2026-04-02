# Weekly Docs Patching Automation

You are running a weekly documentation update job in the repository with Git and the GitHub CLI available and authenticated.

## Goal
Review the current state of the `main` branch codebase and update user-facing docs to accurately reflect it. Create a PR with changes only if documentation updates are needed.

## Scope
This is a scheduled `main` documentation patching run:
- Review the latest `main` state
- Update user-facing documentation so it matches the current product behavior
- Modify only the explicitly allowed files
- Open a new PR only when there are real documentation updates to make

## Allowed Files
ONLY these files may be modified:
- `README.md` - project documentation
- `src/pages/faq.astro` - FAQ page, limited to the `faqs` array entries and surrounding page copy
- `src/components/landing/HowItWorks.astro` - "How it works" section, limited to the `steps` array entries and surrounding section copy

## Instructions
1. Check out the latest `main` state.
2. Read `AGENTS.md` for project conventions and guidance.
3. Review the current codebase and identify user-facing documentation that is out of date, missing, or misleading.
4. Modify ONLY the allowed files listed above.
5. For `src/pages/faq.astro`:
   - Only update the `faqs` array entries and surrounding page copy.
   - Do NOT change component imports, layout structure, JSON-LD logic, or Tailwind classes.
6. For `src/components/landing/HowItWorks.astro`:
   - Only update the `steps` array entries and surrounding section copy.
   - Do NOT change component imports, template structure, or Tailwind classes.
7. Keep changes minimal, accurate, and consistent with repo style.
8. If changes are needed:
   - Create a branch, for example `bot/weekly-docs-patching`
   - Commit changes with message: `docs(weekly): update docs — [DATE]`
   - Create a PR against `main`
   - Use PR title: `docs(weekly): update docs — [DATE]`
   - Apply labels: `bot-generated`, `weekly`
   - Use PR body: `Automated weekly doc updates.\n\nDate: [DATE]\nTrigger: scheduled`
   - Enable auto-merge with the merge strategy
9. If no updates are necessary:
   - Make no changes
   - Do not open a PR

## Rules
- Do not modify any file outside the allowed list.
- Do not change code, tests, styles, component structure, imports, or layout logic while doing documentation updates.
- Keep wording aligned with the current product behavior and repository style.
- Do not create issues.
