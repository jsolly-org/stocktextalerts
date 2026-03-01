import type { APIRoute } from "astro";
import { createSupabaseAdminClient } from "../../lib/db/supabase";

export const prerender = false;

const SHORT_ID_RE = /^[A-Za-z0-9]{6}$/;

export const GET: APIRoute = async ({ params }) => {
	const { id } = params;

	if (!id || !SHORT_ID_RE.test(id)) {
		return new Response("Not Found", { status: 404 });
	}

	const supabase = createSupabaseAdminClient();
	const { data, error } = await supabase
		.from("short_urls")
		.select("original_url, expires_at")
		.eq("id", id)
		.single();

	if (error || !data) {
		return new Response("Not Found", { status: 404 });
	}

	if (new Date(data.expires_at) < new Date()) {
		return new Response("Gone", { status: 410 });
	}

	return new Response(null, {
		status: 302,
		headers: {
			Location: data.original_url,
			"Cache-Control": "no-cache",
		},
	});
};
