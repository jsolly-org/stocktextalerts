/* =============
hCaptcha Utility Functions
============= */

type CallbackWindow<T> = Window & {
	[key: string]: T | undefined;
};

function setWindowCallback<T>(callbackName: string, callback: T) {
	const typedWindow = window as unknown as CallbackWindow<T>;
	typedWindow[callbackName] = callback;
}

export function setupHCaptchaCallback(
	callbackName: string,
	tokenInputId: string,
	formId?: string,
	handler?: (token: string) => void,
) {
	setWindowCallback<(token: string) => void>(callbackName, (token: string) => {
		const input = document.getElementById(tokenInputId);
		if (!(input instanceof HTMLInputElement)) {
			return;
		}

		input.value = token;
		input.dispatchEvent(new Event("input", { bubbles: true }));
		handler?.(token);

		if (formId) {
			const form = document.getElementById(formId);
			if (!(form instanceof HTMLFormElement)) {
				return;
			}

			const submitButton = form.querySelector("button[type='submit']");
			if (!(submitButton instanceof HTMLButtonElement)) {
				return;
			}

			submitButton.disabled = false;
		}
	});
}

export function setupHCaptchaErrorCallback(
	callbackName: string,
	handler?: (errorCode: string) => void,
) {
	const cb =
		handler ||
		((errorCode: string) => {
			console.error("hCaptcha error:", errorCode);
		});
	setWindowCallback<(errorCode: string) => void>(callbackName, cb);
}

export function setupHCaptchaExpiredCallback(
	callbackName: string,
	tokenInputId: string,
	handler?: () => void,
) {
	setWindowCallback<() => void>(callbackName, () => {
		const input = document.getElementById(tokenInputId);
		if (input instanceof HTMLInputElement) {
			input.value = "";
			input.dispatchEvent(new Event("input", { bubbles: true }));
		}

		handler?.();
	});
}

const captchaFormCleanups = new WeakMap<HTMLInputElement, () => void>();

export function initializeHCaptchaForm(formId: string, tokenInputId: string) {
	const setup = () => {
		const form = document.getElementById(formId);
		if (!(form instanceof HTMLFormElement)) {
			return;
		}

		const captchaTokenInput = document.getElementById(tokenInputId);
		if (!(captchaTokenInput instanceof HTMLInputElement)) {
			return;
		}

		const existingCleanup = captchaFormCleanups.get(captchaTokenInput);
		if (existingCleanup) {
			existingCleanup();
		}

		const submitButton = form.querySelector("button[type='submit']");
		if (!(submitButton instanceof HTMLButtonElement)) {
			return;
		}

		const updateDisabledState = () => {
			const hasToken = captchaTokenInput.value.trim().length > 0;
			submitButton.disabled = !hasToken;
		};

		updateDisabledState();

		captchaTokenInput.addEventListener("input", updateDisabledState);

		const cleanup = () => {
			captchaTokenInput.removeEventListener("input", updateDisabledState);
			captchaFormCleanups.delete(captchaTokenInput);
		};

		captchaFormCleanups.set(captchaTokenInput, cleanup);
	};

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", setup);
	} else {
		setup();
	}
}

export function createCaptchaStatusHelpers(statusElementId: string) {
	const statusElement = document.getElementById(statusElementId);

	return {
		show: (message: string) => {
			if (!(statusElement instanceof HTMLElement)) {
				return;
			}

			statusElement.textContent = message;
			statusElement.classList.remove("hidden");
		},
		hide: () => {
			if (!(statusElement instanceof HTMLElement)) {
				return;
			}

			statusElement.textContent = "";
			statusElement.classList.add("hidden");
		},
	};
}

/* =============
hCaptcha Verification
============= */

/*
 * hCaptcha siteverify API returns HTTP 200 with JSON body containing:
 * - success: boolean (true if verification passed)
 * - error-codes: string[] (array of error codes if verification failed)
 *
 * Documented error codes:
 * - "missing-input-secret" - secret key missing
 * - "invalid-input-secret" - secret key invalid/malformed
 * - "missing-input-response" - response token missing
 * - "invalid-input-response" - response token invalid/malformed
 * - "expired-input-response" - response token expired (default 120s)
 * - "already-seen-response" - response token already verified (replay)
 * - "bad-request" - request malformed
 * - "missing-remoteip" - remoteip parameter missing
 * - "invalid-remoteip" - remoteip parameter invalid
 * - "not-using-dummy-passcode" - test sitekey without matching secret
 * - "sitekey-secret-mismatch" - sitekey doesn't belong to secret
 */

export type HCaptchaVerifyResult = {
	success: boolean;
	errorCodes: string[];
};

export async function verifyHCaptchaToken({
	token,
	remoteIp,
}: {
	token: string;
	remoteIp?: string | null;
}): Promise<HCaptchaVerifyResult> {
	// Trim to handle whitespace-only tokens (e.g., accidental spaces in form inputs).
	// External input from hCaptcha widget should not have whitespace, but we normalize before sending
	// because this input cannot be constrained at the DB layer.
	const trimmedToken = token.trim();
	if (trimmedToken.length === 0) {
		return {
			success: false,
			errorCodes: ["missing-input-response"],
		};
	}

	if (import.meta.env.MODE === "test") {
		return {
			success: true,
			errorCodes: [],
		};
	}

	const secret = import.meta.env.HCAPTCHA_SECRET_KEY;
	const siteKey = import.meta.env.PUBLIC_HCAPTCHA_SITE_KEY;

	if (!secret) {
		throw new Error("HCAPTCHA_SECRET_KEY is not configured");
	}

	const payload = new URLSearchParams();
	payload.set("secret", secret);
	payload.set("response", trimmedToken);

	if (remoteIp) {
		payload.set("remoteip", remoteIp);
	}

	if (siteKey) {
		payload.set("sitekey", siteKey);
	}

	const attemptFetch = async (): Promise<Response> => {
		const response = await fetch("https://api.hcaptcha.com/siteverify", {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: payload,
			signal: AbortSignal.timeout(10_000),
		});

		return response;
	};

	let response: Response;
	let lastError: Error | undefined;

	try {
		response = await attemptFetch();

		// hCaptcha API should return HTTP 200 with JSON body containing success/error-codes.
		// Non-200 responses indicate network issues or hCaptcha service outages.
		if (!response.ok) {
			const status = response.status;

			// 4xx errors indicate client-side issues (malformed request, invalid credentials, etc.)
			// These should not be retried.
			if (status >= 400 && status < 500) {
				throw new Error(`hCaptcha verification failed with status ${status}`);
			}

			// 5xx errors or other non-200 responses indicate server issues or network problems.
			// These are transient and worth retrying. Store the status in error for retry detection.
			const serviceError = new Error(`hCaptcha service error: HTTP ${status}`);
			(serviceError as { status?: number }).status = status;
			throw serviceError;
		}
	} catch (error) {
		// Network errors and service errors (5xx) are retryable.
		// Network errors: TypeError (connection failures), DOMException (network errors),
		// AbortError (timeout), TimeoutError (timeout).
		// Service errors: HTTP 5xx responses we create above with status property.
		const errorWithStatus = error as unknown as { status?: number };
		const isRetryableError =
			error instanceof TypeError ||
			error instanceof DOMException ||
			(error instanceof Error &&
				(error.name === "AbortError" ||
					error.name === "TimeoutError" ||
					(typeof errorWithStatus.status === "number" &&
						errorWithStatus.status >= 500)));

		if (!isRetryableError) {
			console.error(
				"hCaptcha verification non-retryable error:",
				errorWithStatus,
			);
			throw error;
		}

		lastError = error as Error;

		// Retry once with 500ms backoff for network failures or service errors.
		await new Promise((resolve) => setTimeout(resolve, 500));
		try {
			response = await attemptFetch();

			if (!response.ok) {
				throw new Error(
					`hCaptcha verification failed with status ${response.status}`,
				);
			}
		} catch (retryError) {
			// If retry also fails, log both errors before throwing the original
			console.error(
				"hCaptcha retry failed:",
				retryError,
				"Original error:",
				lastError,
			);
			throw lastError;
		}
	}

	let data: {
		success?: boolean;
		"error-codes"?: string[];
	};

	try {
		data = (await response.json()) as {
			success?: boolean;
			"error-codes"?: string[];
		};
	} catch (error) {
		// Handle malformed or truncated JSON responses from hCaptcha API
		console.error("Failed to parse hCaptcha response", {
			error: error instanceof Error ? error.message : String(error),
		});
		return {
			success: false,
			errorCodes: ["invalid-json-response"],
		};
	}

	return {
		success: data.success === true,
		errorCodes: Array.isArray(data["error-codes"]) ? data["error-codes"] : [],
	};
}
