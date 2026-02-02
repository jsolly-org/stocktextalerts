import type { APIRoute } from "astro";

function getSecurityTxt(site: string): string {
	const base = new URL(site);
	const contact = `mailto:security@${base.hostname}`;
	const canonical = new URL(".well-known/security.txt", site).href;
	const expires = new Date();
	expires.setFullYear(expires.getFullYear() + 1);

	return `Contact: ${contact}
Expires: ${expires.toISOString()}
Canonical: ${canonical}
Preferred-Languages: en
`;
}

export const GET: APIRoute = ({ site }) => {
	return new Response(getSecurityTxt(site), {
		headers: { "Content-Type": "text/plain; charset=utf-8" },
	});
};
