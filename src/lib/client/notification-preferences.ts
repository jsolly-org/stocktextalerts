import { isUnauthorizedResponse, redirectToSignIn } from "../auth/session/session-expired";
import type { NotificationPreferencesSnapshot } from "../db/types";
import { rootLogger } from "../logging";

/**
 * Fetch the latest notification-preferences snapshot from the server.
 *
 * Returns `null` on failure; redirects to sign-in when the session is unauthorized.
 */
export async function fetchCurrentNotificationPreferences(): Promise<NotificationPreferencesSnapshot | null> {
	try {
		const method = "GET";
		const url = "/api/notification-preferences/current";
		const response = await fetch(url, {
			method,
			credentials: "same-origin",
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(10_000),
		});

		if (!response.ok) {
			if (isUnauthorizedResponse(response)) {
				redirectToSignIn();
				return null;
			}

			const isExpectedRejection = response.status === 422 || response.status === 429;
			const log = isExpectedRejection ? rootLogger.info : rootLogger.error;

			const contentType = response.headers.get("content-type") ?? "";
			let responseBodyText: string | undefined;
			let responseBodyJson: unknown;
			try {
				const rawBody = await response.text();
				if (rawBody) {
					if (contentType.toLowerCase().includes("application/json")) {
						try {
							responseBodyJson = JSON.parse(rawBody) as unknown;
						} catch {
							responseBodyText = rawBody;
						}
					} else {
						responseBodyText = rawBody;
					}
				}
			} catch (error) {
				log(
					"Failed to refresh notification-preferences: HTTP response body read failed",
					{
						action: "refresh_notification-preferences",
						method,
						url,
						status: response.status,
						statusText: response.statusText,
						contentType,
						reason: "response_body_read_failed",
					},
					error,
				);
				return null;
			}

			log("Failed to refresh notification-preferences: non-OK HTTP response", {
				action: "refresh_notification-preferences",
				method,
				url,
				status: response.status,
				statusText: response.statusText,
				contentType,
				responseBodyText,
				responseBodyJson,
			});
			return null;
		}

		const payload = (await response.json()) as {
			ok: boolean;
			notificationPreferences?: NotificationPreferencesSnapshot;
		};

		if (!payload.ok) {
			rootLogger.error("Failed to refresh notification-preferences: payload.ok is false", {
				action: "refresh_notification-preferences",
				method,
				url,
				status: response.status,
				statusText: response.statusText,
				payload,
			});
			return null;
		}

		if (payload.notificationPreferences == null) {
			rootLogger.error("Failed to refresh notification-preferences", {
				action: "refresh_notification-preferences",
				method,
				url,
				status: response.status,
				statusText: response.statusText,
				reason: "notificationPreferences_missing",
				payload,
			});
			return null;
		}

		return payload.notificationPreferences;
	} catch (error) {
		rootLogger.error(
			"Failed to refresh notification-preferences: unexpected error",
			{ action: "refresh_notification-preferences" },
			error,
		);
		return null;
	}
}
