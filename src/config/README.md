# SEO Configuration

This directory contains the single source-of-truth for SEO-related exclusions.

## Files

- **`seo.ts`** - Defines routes excluded from the sitemap and disallowed in robots.txt

## Route Exclusion Lists

### `seoExcludedRoutes`
Routes in this list are:
- Excluded from the sitemap (won't appear in `sitemap-index.xml`)
- Disallowed in `robots.txt` (search engines won't crawl them)

These are typically:
- Authentication flow pages (`/auth/*`)
- User-specific pages (`/dashboard`, `/profile`)
- Utility pages (`/email/unsubscribe`)
- Error pages (`/404`, `/500`)

### `robotsOnlyDisallowedRoutes`
Routes that should be disallowed in `robots.txt` but aren't pages in the sitemap (e.g., API endpoints).

## Making Changes

When you need to add or remove excluded routes:

1. **Edit `src/config/seo.ts`** - Add or remove routes from the appropriate array
2. **Regenerate robots.txt** - Run `npm run seo:generate-robots`
3. **Verify the change** - Run `npm run seo:test-sync`

The `robots.txt` file is auto-generated before every build (via the `prebuild` npm script).

## Testing

A standalone test verifies that:
- All sitemap exclusions are disallowed in robots.txt
- robots.txt contains exactly the expected routes
- robots.txt hasn't been manually edited (matches generated content)

Run the test with:
```bash
npm run seo:test-sync
```

## Integration

- **astro.config.ts** - Imports `seoExcludedRoutes` for the sitemap filter
- **scripts/generate-robots-txt.ts** - Generates `public/robots.txt` from both lists
- **scripts/test-seo-sync.ts** - Standalone test to verify synchronization

This ensures the sitemap and robots.txt can never drift out of sync.
