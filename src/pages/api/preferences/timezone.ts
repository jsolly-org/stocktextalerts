import type { APIRoute } from "astro";
import { createUserService } from "../../../lib/db";
import { createSupabaseServerClient } from "../../../lib/db/supabase";
import { parseWithSchema } from "../../../lib/forms/parse";
import { redirect } from "../../../lib/http/redirect";

export const POST: APIRoute = async ({ request, cookies }) => {
	const supabase = createSupabaseServerClient();
	const users = createUserService(supabase, cookies);

	const authUser = await users.getCurrentUser();
	if (!authUser) {
		console.error("Timezone update attempt without authenticated user");
		return redirect("/signin?error=unauthorized");
	}

	const formData = await request.formData();
	const parsed = parseWithSchema(formData, {
		timezone: { type: "timezone", required: true },
	} as const);

	if (!parsed.ok) {
		console.error("Timezone update rejected due to invalid form", {
			errors: parsed.allErrors,
		});
		return redirect("/dashboard?error=invalid_form");
	}

	try {
		await users.update(authUser.id, {
			timezone: parsed.data.timezone,
		});
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		console.error("Failed to update timezone", {
			userId: authUser.id,
			timezone: parsed.data.timezone,
			error: errorMessage,
		});
		return redirect("/dashboard?error=update_failed");
	}

	return redirect("/dashboard?success=timezone_updated");
};
