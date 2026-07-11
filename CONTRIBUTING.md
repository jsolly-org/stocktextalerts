# Contributing

Thanks for contributing to StockTextAlerts.

## Setup

1. Use the Node version in [`.nvmrc`](.nvmrc).
2. Follow the local quickstart in [README.md](README.md) (`cp env.example .env.local`, replace `<placeholders>`, `npm ci`, `db:start`, `db:reset`, `npm run dev`).
3. Details on ports, Mailpit, and Astro 7 locks: [docs/tooling-setup.md](docs/tooling-setup.md).

Self-hosting / production bootstrap (not required for most PRs): [docs/self-hosting.md](docs/self-hosting.md).

## Checks before you push

Local pre-commit runs lint/types/static checks (Biome, TypeScript, Knip, SQL lint, migration grants, Lambda bundle build, …). You can also run:

```bash
npm run check:biome
npm run check:ts
```

**Unit and E2E tests are not the local merge gate.** GitHub Actions is canonical. To debug against local Supabase:

```bash
npm run test:local
npm run test:e2e:local
```

See [tests/README.md](tests/README.md). Do not force-clear the cross-worktree `test.lock` unless you are sure the holder PID is dead.

## Pull requests

- Branch off `main`, open a PR, and let CI pass.
- Keep changes focused; update docs when behavior or setup steps change.
- Schema changes: add a migration with `supabase migration new <name>`, bump schema version as documented in the repo, and ensure grants match the privilege contract (`npm run check:migration-grants` / CI).
- Notification options: edit `NOTIFICATION_OPTION_MATRIX` in `src/lib/constants.ts` **and** sync `notification_options` via migration.

## Deploy

Contributors do not need deploy credentials. Maintainers: production web + Lambda/migrations deploy from `main` as described in [docs/self-hosting.md](docs/self-hosting.md) and [docs/github-ci.md](docs/github-ci.md).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
