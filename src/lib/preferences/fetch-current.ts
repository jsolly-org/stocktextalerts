import type { PreferencesSnapshot } from "../db";
import { rootLogger } from "../logging";

export async function fetchCurrentPreferences(): Promise<PreferencesSnapshot | null> {
	try {
		const method = "GET";
		const url = "/api/preferences/current";
		const response = await fetch(url, {
			method,
			credentials: "same-origin",
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(10_000),
		});

		if (!response.ok) {
			const isExpectedRejection =
				response.status === 401 ||
				response.status === 403 ||
				response.status === 422 ||
				response.status === 429;
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
					"Failed to refresh preferences: HTTP response body read failed",
					{
						action: "refresh_preferences",
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

			log("Failed to refresh preferences: non-OK HTTP response", {
				action: "refresh_preferences",
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
			preferences?: PreferencesSnapshot;
		};

		if (!payload.ok) {
			rootLogger.error("Failed to refresh preferences: payload.ok is false", {
				action: "refresh_preferences",
				method,
				url,
				status: response.status,
				statusText: response.statusText,
				payload,
			});
			return null;
		}

		if (payload.preferences == null) {
			rootLogger.error("Failed to refresh preferences", {
				action: "refresh_preferences",
				method,
				url,
				status: response.status,
				statusText: response.statusText,
				reason: "preferences_missing",
				payload,
			});
			const error = new Error("Missing preferences in successful response");
			error.name = "PreferencesContractViolationError";
			throw error;
		}

		return payload.preferences;
	} catch (error) {
		if (
			error instanceof Error &&
			error.name === "PreferencesContractViolationError"
		) {
			throw error;
		}
		rootLogger.warn(
			"Failed to refresh preferences: unexpected error",
			{ action: "refresh_preferences" },
			error,
		);
		return null;
	}
}
