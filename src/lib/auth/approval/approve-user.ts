import type { AppSupabaseClient } from "../../db/supabase";
import type { Logger } from "../../logging/types";
import { sendUserApprovalEmail } from "./user-approved-email";

type ApprovePendingUserOptions = {
	adminSupabase: AppSupabaseClient;
	targetUserId: string;
	approvedBy: string;
	logger: Logger;
};

type ApprovePendingUserResult =
	| { status: "approved"; emailSent: true; email: string }
	| { status: "approved_email_failed"; emailSent: false; email: string }
	| { status: "already_approved"; emailSent: false; email: string }
	| { status: "not_found"; emailSent: false };

export async function approvePendingUser(
	options: ApprovePendingUserOptions,
): Promise<ApprovePendingUserResult> {
	const { adminSupabase, targetUserId, approvedBy, logger } = options;

	const { data: targetUser, error: fetchError } = await adminSupabase
		.from("users")
		.select("id, email, approved_at")
		.eq("id", targetUserId)
		.maybeSingle();

	if (fetchError) {
		logger.error("Failed to load user for approval", { userId: targetUserId }, fetchError);
		throw fetchError;
	}

	if (!targetUser) {
		return { status: "not_found", emailSent: false };
	}

	if (targetUser.approved_at) {
		return { status: "already_approved", emailSent: false, email: targetUser.email };
	}

	const approvedAt = new Date().toISOString();
	const { data: updatedRows, error: updateError } = await adminSupabase
		.from("users")
		.update({
			approved_at: approvedAt,
			approved_by: approvedBy,
		})
		.eq("id", targetUserId)
		.is("approved_at", null)
		.select("id, email")
		.limit(1);

	if (updateError) {
		logger.error("Failed to approve user", { userId: targetUserId }, updateError);
		throw updateError;
	}

	const updatedUser = updatedRows?.[0];
	if (!updatedUser) {
		return { status: "already_approved", emailSent: false, email: targetUser.email };
	}

	const emailResult = await sendUserApprovalEmail(
		{ id: updatedUser.id, email: updatedUser.email },
		logger,
	);

	if (!emailResult.success) {
		return { status: "approved_email_failed", emailSent: false, email: updatedUser.email };
	}

	return { status: "approved", emailSent: true, email: updatedUser.email };
}
