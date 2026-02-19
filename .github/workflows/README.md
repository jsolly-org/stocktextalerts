# CI Pipeline Workflows

## Post-Dev-Push

The [post-dev-push](post-dev-push.yml) workflow runs after every push to `dev`. It has three main phases:

1. **Discover** — An agent reviews the pushed changes (commit diff, associated PR) and identifies high-quality follow-up tasks. It writes up to 3 tasks to `/tmp/followups.json`, avoiding duplicates with open or recently merged PRs.

2. **Parse** — The workflow validates the JSON and prepares a matrix of tasks.

3. **Create follow-up PRs** — For each task, a parallel job checks out `dev`, runs the agent to implement the task (leaving changes uncommitted), runs pre-commit checks, and — if successful — commits, pushes to a branch, and creates a PR against `dev`.

The workflow also has an **update-docs** job that updates `README.md`, `src/pages/faq.astro`, and `src/components/landing/HowItWorks.astro` to reflect the pushed changes.

### How it differs from nightly-issue-grooming

The previous **nightly-issue-grooming** flow ran on a schedule, discovered open issues needing work, and created PRs. The post-dev-push workflow replaces that approach by:

- Triggering on **pushes to dev** instead of a nightly cron
- Deriving follow-ups from **recent code changes** rather than a backlog of issues
- Keeping tasks tightly scoped and context-aware (the agent sees the exact diff that inspired each task)

This yields more relevant, higher-quality follow-up work tied directly to what was just merged.
