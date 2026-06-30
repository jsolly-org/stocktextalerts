import type { APIRoute } from "astro";
import { isApprovalAdminEmail } from "../../../../lib/auth/approval/admin";
import { approvePendingUser } from "../../../../lib/auth/approval/approve-user";
import { buildSigninRedirectUrl } from "../../../../lib/auth/redirects";
import { createUserService } from "../../../../lib/auth/user-service";
import { createSupabaseAdminClient, createSupabaseServerClient } from "../../../../lib/db/supabase";
import { createLogger } from "../../../../lib/logging";

function redirectForResult(status: string): string {
	switch (status) {
		case "approved":
			return "/admin/users?success=approved";
		case "approved_email_failed":
			return "/admin/users?warning=email_failed";
		case "already_approved":
			return "/admin/users?info=already_approved";
		case "not_found":
			return "/admin/users?error=user_not_found";
		default:
			return "/admin/users?error=failed";
	}
}

export const POST: APIRoute = async ({ request, cookies, locals, redirect }) => {
	const logger = createLogger({
		requestId: locals?.requestId,
		path: new URL(request.url).pathname,
		method: request.method,
	});
	const supabase = createSupabaseServerClient();
	const users = createUserService(supabase, cookies);
	const authUser = await users.getCurrentUser();

	if (!authUser) {
		return redirect(buildSigninRedirectUrl("/api/admin/users/approve"));
	}

	if (!isApprovalAdminEmail(authUser.email)) {
		logger.info("Non-admin attempted to approve user", { userId: authUser.id });
		return new Response("Forbidden", { status: 403 });
	}

	const formData = await request.formData();
	const targetUserId = formData.get("user_id");
	if (typeof targetUserId !== "string" || targetUserId.trim().length === 0) {
		return redirect("/admin/users?error=invalid_form");
	}

	try {
		const result = await approvePendingUser({
			adminSupabase: createSupabaseAdminClient(),
			targetUserId,
			approvedBy: authUser.email ?? authUser.id,
			logger,
		});

		return redirect(redirectForResult(result.status));
	} catch (error) {
		logger.error("Admin user approval failed", { adminUserId: authUser.id, targetUserId }, error);
		return redirect("/admin/users?error=failed");
	}
};
