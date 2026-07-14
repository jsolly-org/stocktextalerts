import type { AppSupabaseClient } from "../db/supabase";
import { rootLogger } from "../logging";
import type { NotificationBudgetKind } from "./constants";

/** Outcome of try_consume_notification_budget (fail-closed on transport/RPC errors). */
export type NotificationBudgetConsumeResult =
	| { status: "reserved" }
	| { status: "denied" }
	| { status: "error" };

/**
 * Atomically reserve `count` units of today's ET-day notification budget.
 * Distinguishes hard deny from RPC/transport failure so callers can terminal-skip
 * vs retry. Fail-closed: any unexpected payload is treated as `error`.
 */
export async function consumeNotificationBudget(
	supabase: AppSupabaseClient,
	options: {
		userId: string;
		kind: NotificationBudgetKind;
		count?: number;
	},
): Promise<NotificationBudgetConsumeResult> {
	const count = options.count ?? 1;
	const { data, error } = await supabase.rpc("try_consume_notification_budget", {
		p_user_id: options.userId,
		p_kind: options.kind,
		p_count: count,
	});

	if (error) {
		rootLogger.error(
			"Failed to consume notification budget (fail closed)",
			{ userId: options.userId, kind: options.kind, count },
			error,
		);
		return { status: "error" };
	}

	if (data === true) {
		return { status: "reserved" };
	}
	if (data === false) {
		return { status: "denied" };
	}

	rootLogger.error(
		"Unexpected notification budget consume payload (fail closed)",
		{ userId: options.userId, kind: options.kind, count, data: data ?? null },
		new Error("try_consume_notification_budget returned non-boolean"),
	);
	return { status: "error" };
}

/**
 * Refund previously consumed budget after a send failure. Best-effort: logs on
 * error but does not throw (the send already failed).
 */
export async function releaseNotificationBudget(
	supabase: AppSupabaseClient,
	options: {
		userId: string;
		kind: NotificationBudgetKind;
		count?: number;
	},
): Promise<void> {
	const count = options.count ?? 1;
	const { error } = await supabase.rpc("release_notification_budget", {
		p_user_id: options.userId,
		p_kind: options.kind,
		p_count: count,
	});

	if (error) {
		rootLogger.error(
			"Failed to release notification budget after send failure",
			{ userId: options.userId, kind: options.kind, count },
			error,
		);
	}
}
