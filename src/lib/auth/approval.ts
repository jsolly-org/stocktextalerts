import type { Database } from "../db/generated/database.types";

type ApprovedAt = Database["public"]["Tables"]["users"]["Row"]["approved_at"];

export function isApprovedAtValue(approvedAt: ApprovedAt): boolean {
	return typeof approvedAt === "string" && approvedAt.trim().length > 0;
}

export function isUserApproved(user: { approved_at: ApprovedAt }): boolean {
	return isApprovedAtValue(user.approved_at);
}
