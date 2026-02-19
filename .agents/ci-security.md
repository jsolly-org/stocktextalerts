## CI Security Model

### Agent trust boundary

Our nightly CI workflows give the Cursor agent write access to the repository (via `GH_AGENT_TOKEN`). We intentionally **do not** restrict which files the agent can modify — including `.github/workflows/` and `.github/actions/`.

**Rationale:** An agent that can write arbitrary source code can write malicious source code just as easily as malicious workflow code. Singling out workflow files provides no real security benefit while preventing legitimate fixes (e.g. merge conflict resolution in workflow files). The trust boundary is the agent itself, not the file paths it touches.

### Mitigations

- **Branch protection**: Agent commits land on feature branches, never directly on `main` or `dev`. All changes go through PR review.
- **Attempt limits**: Nightly grooming stops after 2 fix attempts per PR to prevent runaway loops.
- **Scoped tokens**: `GH_AGENT_TOKEN` is a fine-grained PAT with only the permissions the workflows need.

### Why `GH_AGENT_TOKEN` instead of `GITHUB_TOKEN`

GitHub's default `GITHUB_TOKEN` cannot push changes to files under `.github/workflows/`. This is a built-in GitHub restriction — even with `contents: write` permission, pushes that modify workflow files are rejected. To allow the agent to resolve merge conflicts and make legitimate fixes in workflow files, we use `GH_AGENT_TOKEN` (a fine-grained PAT stored as a repository secret) for both the `actions/checkout` step and `git push`. This PAT has the `workflows` scope, which grants permission to modify workflow files via push.
