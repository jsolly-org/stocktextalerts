/* =============
hCaptcha Verification
============= */

export type HCaptchaVerifyResult = {
	success: boolean;
	errorCodes: string[];
};

export function getRequestIp(request: Request): string | null {
	const forwardedFor = request.headers.get("x-forwarded-for");
	if (forwardedFor) {
		// Trim to handle potential whitespace from proxy headers
		const first = forwardedFor.split(",")[0]?.trim();
		if (first) {
			return first;
		}
	}

	const realIp = request.headers.get("x-real-ip");
	// Trim to handle potential whitespace from proxy headers
	return realIp?.trim() || null;
}

export async function verifyHCaptchaToken({
	token,
	remoteIp,
}: {
	token: string;
	remoteIp?: string | null;
}): Promise<HCaptchaVerifyResult> {
	// Trim to handle whitespace-only tokens (e.g., accidental spaces in form inputs)
	// External input from hCaptcha widget should not have whitespace, but we validate defensively
	if (!token || token.trim().length === 0) {
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
	payload.set("response", token);

	if (remoteIp) {
		payload.set("remoteip", remoteIp);
	}

	if (siteKey) {
		payload.set("sitekey", siteKey);
	}

	const response = await fetch("https://api.hcaptcha.com/siteverify", {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: payload,
		signal: AbortSignal.timeout(10_000),
	});

	if (!response.ok) {
		throw new Error(
			`hCaptcha verification failed with status ${response.status}`,
		);
	}

	const data = (await response.json()) as {
		success?: boolean;
		"error-codes"?: string[];
	};

	return {
		success: data.success === true,
		errorCodes: Array.isArray(data["error-codes"]) ? data["error-codes"] : [],
	};
}
