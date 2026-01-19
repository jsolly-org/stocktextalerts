import type { APIRoute } from "astro";
import { createUserService } from "../../../lib/db";
import {
	createSupabaseAdminClient,
	createSupabaseServerClient,
} from "../../../lib/db/supabase";
import { createEmailSender } from "./email/utils";
import { processEmailUpdate } from "./processing";
import { calculateNextSendAt, loadUserStocks } from "./shared";

export const POST: APIRoute = async ({ cookies, request, redirect }) => {
	const supabase = createSupabaseServerClient();
	const users = createUserService(supabase, cookies);

	const authUser = await users.getCurrentUser();
	if (!authUser) {
		console.error(
			"Manual daily digest send attempt without authenticated user",
		);
		return redirect("/signin?error=unauthorized");
	}

	const supabaseAdmin = createSupabaseAdminClient();

	const { data: user, error: userError } = await supabaseAdmin
		.from("users")
		.select(
			`
				id,
				email,
				timezone,
				daily_digest_enabled,
				daily_digest_notification_time,
				next_send_at,
				email_notifications_enabled
			`,
		)
		.eq("id", authUser.id)
		.maybeSingle();

	if (userError) {
		console.error("Failed to load user for manual daily digest send", {
			userId: authUser.id,
			error: userError.message,
		});
		return redirect("/dashboard?error=server_error");
	}

	if (!user) {
		console.error("Manual daily digest send attempted but user not found", {
			userId: authUser.id,
		});
		return redirect("/dashboard?error=user_not_found");
	}

	if (!user.daily_digest_enabled) {
		return redirect("/dashboard?error=daily_digest_disabled");
	}

	if (!user.email_notifications_enabled) {
		return redirect("/dashboard?error=email_notifications_disabled");
	}

	try {
		const url = new URL(request.url);
		const skipNext = url.searchParams.get("skip_next") === "1";

		const originalNextSendAt = user.next_send_at;
		if (skipNext) {
			if (typeof originalNextSendAt === "string") {
				const dueAt = new Date(originalNextSendAt);
				const advancedNextSendAt = calculateNextSendAt(
					user.daily_digest_notification_time,
					user.timezone,
					() => new Date(dueAt.getTime() + 1000),
				);
				if (!advancedNextSendAt) {
					console.error("Failed to calculate advanced next_send_at", {
						userId: user.id,
						daily_digest_notification_time: user.daily_digest_notification_time,
						timezone: user.timezone,
					});
					return redirect("/dashboard?error=daily_digest_skip_failed");
				}

				const { error: advanceError } = await supabaseAdmin
					.from("users")
					.update({ next_send_at: advancedNextSendAt.toISOString() })
					.eq("id", user.id);

				if (advanceError) {
					console.error("Failed to advance next_send_at for skip", {
						userId: user.id,
						error: advanceError.message,
					});
					return redirect("/dashboard?error=daily_digest_skip_failed");
				}
			}
		}

		const sendEmail = createEmailSender();
		const userStocks = await loadUserStocks(supabaseAdmin, user.id);

		const stocksList =
			userStocks.length === 0
				? "You don't have any tracked stocks"
				: userStocks
						.map((stock) => `${stock.symbol} - ${stock.name}`)
						.join(", ");

		const minuteBucket = new Date().toISOString().slice(0, 16);
		const idempotencyKey = `daily-digest-now/${user.id}/${minuteBucket}`;

		const result = await processEmailUpdate(
			supabaseAdmin,
			{ id: user.id, email: user.email },
			userStocks,
			stocksList,
			sendEmail,
			idempotencyKey,
		);

		if (!result.sent) {
			console.error("Manual daily digest send failed", {
				userId: user.id,
				error: result.error ?? "unknown",
				errorCode: result.errorCode,
			});
			return redirect("/dashboard?error=daily_digest_send_failed");
		}

		return redirect("/dashboard?success=daily_digest_sent");
	} catch (error) {
		console.error("Unexpected error sending manual daily digest", {
			userId: user.id,
			error: error instanceof Error ? error.message : String(error),
		});
		return redirect("/dashboard?error=daily_digest_send_failed");
	}
};
