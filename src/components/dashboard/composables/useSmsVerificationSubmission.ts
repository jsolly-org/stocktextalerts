import { nextTick, ref } from "vue";
import {
	isUnauthorizedResponse,
	redirectToSignIn,
} from "../../../lib/auth/session/session-expired";
import type { ApiJsonBody } from "../../../lib/client/json-response";
import type { User } from "../../../lib/db";
import type { FlashTone } from "../../ui-constants";
import { DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID } from "../constants";

type SmsVerificationPayload = ApiJsonBody & { tone?: FlashTone };

/**
 * Composable that handles sending an SMS verification code and verifying the OTP.
 *
 * Performs API requests, updates local `user` state so the UI stays in sync, and redirects to
 * sign-in if the session is unauthorized.
 */
export function useSmsVerificationSubmission(options: {
	user: { value: User };
	isEditingPhone: { value: boolean };
	smsSuccessMessage: { value: string | null };
	setNotificationPreferencesFlashMessage: (tone: FlashTone, messageKey: string) => void;
	clearNotificationPreferencesFlashTone: (tone: FlashTone) => void;
	handleNotificationPreferencesUpdated: () => Promise<void>;
}) {
	const isVerifyingCode = ref(false);
	const isSendingVerification = ref(false);

	/** Parse a JSON response into the expected payload shape, returning null on parse failure. */
	const parseResponsePayload = async (res: Response): Promise<SmsVerificationPayload | null> => {
		try {
			return (await res.json()) as SmsVerificationPayload;
		} catch {
			return null;
		}
	};

	/**
	 * After requesting a verification code, update local user state so the OTP UI can render
	 * immediately without a full refresh.
	 */
	const updateLocalUserAfterVerificationSent = (formData: FormData) => {
		const phoneCountryCode = formData.get("phone_country_code");
		const phoneNumber = formData.get("phone_number");
		if (typeof phoneCountryCode !== "string" || typeof phoneNumber !== "string") {
			return;
		}
		if (phoneCountryCode === "" || phoneNumber === "") {
			return;
		}

		options.user.value = {
			...options.user.value,
			phone_country_code: phoneCountryCode,
			phone_number: phoneNumber,
			phone_verified: false,
			verification_sent_at: new Date().toISOString(),
		} as User & { verification_sent_at: string };
	};

	/**
	 * After successful OTP verification, update local state to reflect the verified phone number.
	 */
	const updateLocalUserAfterPhoneVerified = () => {
		options.user.value = {
			...options.user.value,
			phone_verified: true,
			verification_sent_at: null,
		} as User & { verification_sent_at: null };
		options.isEditingPhone.value = false;
	};

	/** Focus the first OTP digit input after a verification code is sent. */
	const focusFirstOtpDigit = async () => {
		await nextTick();
		const firstOtpInputId = `${DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID}-sms-verification-code-0`;
		const otp0 = document.getElementById(firstOtpInputId);
		if (!(otp0 instanceof HTMLInputElement)) {
			return;
		}
		otp0.focus();
		otp0.select();
	};

	/**
	 * Intercept the SMS verification form submit and route it to the correct API endpoint.
	 *
	 * Returns `true` when the submit was handled (and default navigation should be suppressed).
	 */
	const handleSmsVerificationSubmit = async (event: SubmitEvent) => {
		const submitter = event.submitter;
		const action = submitter instanceof HTMLElement ? submitter.getAttribute("formaction") : null;
		const isVerifyCodeSubmission = action === "/api/auth/sms/verify-code";
		const isSendVerificationSubmission = action === "/api/auth/sms/send-verification";
		if (!isVerifyCodeSubmission && !isSendVerificationSubmission) {
			return false;
		}

		event.preventDefault();
		isVerifyingCode.value = isVerifyCodeSubmission;
		isSendingVerification.value = isSendVerificationSubmission;

		try {
			const form = event.target;
			if (!(form instanceof HTMLFormElement)) {
				options.setNotificationPreferencesFlashMessage("error", "failed");
				options.smsSuccessMessage.value = null;
				return true;
			}

			const formData = new FormData(form);
			const res = await fetch(action, {
				method: "POST",
				body: formData,
				credentials: "same-origin",
				headers: { Accept: "application/json" },
			});

			if (isUnauthorizedResponse(res)) {
				redirectToSignIn();
				return true;
			}

			const payload = await parseResponsePayload(res);
			if (!payload || typeof payload.message !== "string") {
				options.setNotificationPreferencesFlashMessage("error", "failed");
				options.smsSuccessMessage.value = null;
				return true;
			}

			const messageKey = payload.message;
			const tone = payload.tone ?? (payload.ok ? "success" : "error");

			if (messageKey === "verification_sent") {
				options.smsSuccessMessage.value = "verification_sent";
				options.clearNotificationPreferencesFlashTone("error");
				options.clearNotificationPreferencesFlashTone("warning");
				options.isEditingPhone.value = false;
			} else {
				options.smsSuccessMessage.value = null;
				options.setNotificationPreferencesFlashMessage(tone, messageKey);
			}

			// After successfully sending verification, update local user state so the UI
			// switches to the OTP interface immediately.
			if (isSendVerificationSubmission && messageKey === "verification_sent") {
				updateLocalUserAfterVerificationSent(formData);
			}

			// After successfully verifying the code, update local user state so the UI
			// shows "Phone verified" without requiring a refresh.
			if (isVerifyCodeSubmission && messageKey === "phone_verified") {
				updateLocalUserAfterPhoneVerified();
			}

			// Keep notification-preferences state in sync after verification.
			if (isVerifyCodeSubmission && messageKey === "phone_verified") {
				await options.handleNotificationPreferencesUpdated();
			}

			// Focus the first OTP digit after sending the verification code so the user
			// can immediately type/paste without extra clicks.
			if (isSendVerificationSubmission && messageKey === "verification_sent") {
				await focusFirstOtpDigit();
			}

			return true;
		} catch {
			options.setNotificationPreferencesFlashMessage("error", "failed");
			options.smsSuccessMessage.value = null;
			return true;
		} finally {
			isVerifyingCode.value = false;
			isSendingVerification.value = false;
		}
	};

	return {
		handleSmsVerificationSubmit,
		isSendingVerification,
		isVerifyingCode,
	};
}
