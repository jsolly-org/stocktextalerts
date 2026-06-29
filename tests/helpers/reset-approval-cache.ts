import { approvalCache } from "../../src/lib/db/approval-cache-store";

export function resetApprovalCache(): void {
	approvalCache.clear();
}
