## Code Style & Structure

### Compatibility
- **No compatibility layers**: No shims, adapters, deprecations, or re-exports for legacy behavior.
- **No browser polyfills**: Modern browser APIs (`fetch`, `URL`, `AbortController`, `crypto.randomUUID()`, etc.) are assumed. Server-side polyfills (e.g., `@js-temporal/polyfill`) are fine when Node.js lacks the API.

### Imports
- **Relative paths only**: No `@`-style aliases.
- **No barrel files / re-exports**: Import from the defining module, not intermediary files.

### Styling
- **Tailwind utilities** over custom CSS.
- **Semantic tokens** in `src/global.css` via Tailwind v4 `@theme` (primary, success, warning, error, info).
- **Status UI**: Use `StatusMessage.astro` / `StatusMessage.vue` or `status-tone-*` classes.
- **Neutral palette**: `gray-*` utilities for surfaces/text/borders.
- **Avoid `:global(...)` in Astro component styles**: Prefer scoped selectors or shared classes in `src/global.css`.
- **Allowed exception**: Use `:global(...)` only when styling markup outside the local scope boundary (for example, classes inside icon/SVG internals rendered by another component).

### Timing
- No `setTimeout`/`nextTick`/`requestAnimationFrame` to mask race conditions. Fix the root cause. Legitimate uses (debouncing, throttling) are fine.
