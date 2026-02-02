# Run pre-commit checks

Composite action to run `npm ci`, `npx biome ci .`, and `npm run check:ts` with
grouped logs saved as `precommit-*.log`.
