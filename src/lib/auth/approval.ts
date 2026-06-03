import type { User } from "../db";

export function isUserApproved(user: Pick<User, "approved_at">): boolean {
	return typeof user.approved_at === "string" && user.approved_at.trim().length > 0;
}
