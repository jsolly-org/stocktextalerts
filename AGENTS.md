## Purpose
New app with no users — optimize for simplicity and correctness over backwards compatibility. Prefer aggressively simplifying redesigns, even if breaking. Remove legacy code instead of preserving it.

## Commands
- `npm run build` — Production build
- `npm test` — Run Vitest tests
- `npm run test:e2e` — Playwright E2E tests
- `npm run check:ts` — TypeScript check
- `npm run check:biome` — Lint check
- `npm run fix` — Auto-fix lint issues
- `npm run db:reset` — Reset local Supabase DB
- `npm run db:gen-types` — Regenerate DB types

## Guidelines
- [Code Style & Structure](.agents/code-style.md)
- [Error Handling & Validation](.agents/error-handling.md)
- [Tech Stack & Tools](.agents/tech-stack.md)
- [Testing](.agents/testing.md)
