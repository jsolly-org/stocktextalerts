## CI & Deployment

### Agent Trust Boundary

Our nightly CI workflows give the Cursor agent write access to the repository (via `GH_AGENT_TOKEN`). We intentionally **do not** restrict which files the agent can modify — including `.github/workflows/` and `.github/actions/`.

**Rationale:** An agent that can write arbitrary source code can write malicious source code just as easily as malicious workflow code. Singling out workflow files provides no real security benefit while preventing legitimate fixes (e.g. merge conflict resolution in workflow files). The trust boundary is the agent itself, not the file paths it touches.

### Mitigations

- **Branch protection**: Agent commits land on feature branches, never directly on `main` or `dev`. All changes go through PR review.
- **Attempt limits**: Nightly grooming stops after 2 fix attempts per PR to prevent runaway loops.
- **Scoped tokens**: `GH_AGENT_TOKEN` is a fine-grained PAT with only the permissions the workflows need.

### Why `GH_AGENT_TOKEN` Instead of `GITHUB_TOKEN`

GitHub's default `GITHUB_TOKEN` cannot push changes to files under `.github/workflows/`. This is a built-in GitHub restriction — even with `contents: write` permission, pushes that modify workflow files are rejected. To allow the agent to resolve merge conflicts and make legitimate fixes in workflow files, we use `GH_AGENT_TOKEN` (a fine-grained PAT stored as a repository secret) for both the `actions/checkout` step and `git push`. This PAT has the `workflows` scope, which grants permission to modify workflow files via push.

### `GH_AGENT_TOKEN` Setup

**Where to add:** Repository Settings → Secrets and variables → Actions → New repository secret → name: `GH_AGENT_TOKEN`.

**How to create:** Use a [Personal Access Token (classic)](https://github.com/settings/tokens) or [fine-grained token](https://github.com/settings/personal-access-tokens/new).

**Required permissions:**

| Token type   | Permissions |
|--------------|-------------|
| Classic PAT  | `repo` and `workflow` |
| Fine-grained | `Contents: Read and write`, `Pull requests: Read and write`, `Workflows: Read and write`, `Issues: Read and write` |

Fine-grained: restrict to "Only select repositories" → this repo. Classic: no additional scopes beyond `repo` and `workflow`.

**Token lifecycle:**
- Set an expiration period appropriate for your security policy (recommended: 90 days).
- When the token expires, workflows will fail with authentication errors. Create a new token and update the repository secret.
- Consider setting a calendar reminder for token renewal.

### `vars.AGENT_MODEL`

All 8 nightly agent workflows read the model name from the GitHub repository variable `AGENT_MODEL` (e.g. `claude-sonnet-4-20250514`). This lets you change which model every workflow uses from a single place.

**Where to set:** Repository Settings → Secrets and variables → Actions → Variables tab → `AGENT_MODEL`.

### `vars.PRODUCTION_SITE_URL`

The deploy workflow builds the site with this URL so the prebuilt output (prerendered pages, sitemap, canonicals, OG images, JSON-LD) uses the production domain instead of localhost. Required for correct production deploys when using `vercel deploy --prebuilt` and `ignoreCommand` to skip Vercel's Git build.

**Where to set:** Repository Settings → Secrets and variables → Actions → Variables tab → `PRODUCTION_SITE_URL` (e.g. `https://stocktextalerts.com`).
