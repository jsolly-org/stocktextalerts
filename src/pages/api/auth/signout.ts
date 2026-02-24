import type { APIRoute } from "astro";
import { clearAuthCookies } from "../../../lib/auth/cookies";
import { getSafeRedirectPath } from "../../../lib/auth/redirects";
import { escapeHtml } from "../../../lib/messaging/asset-formatting";

function getSafeNext(nextParam: string | null): string {
	return getSafeRedirectPath(nextParam) ?? "/";
}

export const POST: APIRoute = async ({ cookies, redirect, url }) => {
	clearAuthCookies(cookies);
	const next = getSafeNext(url?.searchParams.get("next") ?? null);
	return redirect(next);
};

// GET is non-state-changing to avoid accidental sign-outs via prefetches/crawlers.
export const GET: APIRoute = async ({ url }) => {
	const next = getSafeNext(url.searchParams.get("next"));
	const action = `/api/auth/signout?next=${encodeURIComponent(next)}`;
	const safeAction = escapeHtml(action);
	const safeNext = escapeHtml(next);
	const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Sign out</title>
  </head>
  <body>
    <main style="max-width: 32rem; margin: 4rem auto; padding: 0 1rem; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;">
      <h1 style="font-size: 1.5rem; margin: 0 0 0.75rem;">Sign out</h1>
      <p style="margin: 0 0 1.25rem; line-height: 1.4;">
        Confirm you want to sign out.
      </p>
      <form method="POST" action="${safeAction}">
        <button type="submit" style="padding: 0.6rem 1rem; font-weight: 600; cursor: pointer;">
          Sign out
        </button>
        <a href="${safeNext}" style="margin-left: 0.75rem;">Cancel</a>
      </form>
    </main>
  </body>
</html>`;

	return new Response(html, {
		status: 200,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
		},
	});
};
