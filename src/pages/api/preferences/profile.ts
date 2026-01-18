import type { APIRoute } from "astro";
import { coerceWithSchema } from "../../../lib/forms/coercion";
import type { FormSchema } from "../../../lib/forms/schema";
import { omitUndefined } from "../../../lib/forms/utils";
import { createSupabaseServerClient } from "../../../lib/supabase";
import { createUserService } from "../../../lib/users";

interface ProfilePreferencesDependencies {
	createSupabaseServerClient: typeof createSupabaseServerClient;
	createUserService: typeof createUserService;
}

const defaultDependencies: ProfilePreferencesDependencies = {
	createSupabaseServerClient,
	createUserService,
};

export function createProfilePreferencesHandler(
	overrides: Partial<ProfilePreferencesDependencies> = {},
): APIRoute {
	const dependencies = { ...defaultDependencies, ...overrides };

	return async ({ request, cookies, redirect }) => {
		const supabase = dependencies.createSupabaseServerClient();
		const userService = dependencies.createUserService(supabase, cookies);

		const user = await userService.getCurrentUser();
		if (!user) {
			console.error(
				"Profile preferences update attempt without authenticated user",
			);
			return redirect("/signin?error=unauthorized");
		}

		const formData = await request.formData();
		const shape = {
			timezone: { type: "timezone" },
		} as const satisfies FormSchema;

		const parsed = coerceWithSchema(formData, shape, (body) => ({
			preferenceUpdates: omitUndefined({
				timezone: body.timezone,
			}),
		}));

		if (!parsed.ok) {
			console.error("Profile preferences update rejected due to invalid form", {
				errors: parsed.allErrors,
			});
			return redirect("/profile?error=invalid_form");
		}

		const { preferenceUpdates } = parsed.data;
		if (Object.keys(preferenceUpdates).length === 0) {
			console.error(
				"Profile preferences update rejected: no updates provided",
				{ userId: user.id },
			);
			return redirect("/profile?error=no_updates");
		}

		try {
			await userService.update(user.id, preferenceUpdates);
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);

			console.error("Failed to update profile preferences", {
				userId: user.id,
				preferences: preferenceUpdates,
				error: errorMessage,
			});

			return redirect("/profile?error=update_failed");
		}

		return redirect("/profile?success=settings_updated");
	};
}

export const POST = createProfilePreferencesHandler();
