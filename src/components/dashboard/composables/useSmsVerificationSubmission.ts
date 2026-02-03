import { nextTick, ref } from "vue";
import {
	DASHBOARD_NOTIFICATION_PREFERENCES_FORM_ID,
	type FlashTone,
} from "../../../lib/constants";
import type { User } from "../../../lib/db";

type SmsVerificationPayload = {
	ok: boolean;
	message?: string;
	tone?: FlashTone;
};

export function useSmsVerificationSubmission(options: {
	user: { value: User };
	isEditingPhone: { value: boolean };
	smsSuccessMessage: { value: string | null };
	setNotificationPreferencesFlashMessage: (
		tone: FlashTone,
		messageKey: string,
	) => void;
	clearNotificationPreferencesFlashTone: (tone: FlashTone) => void;
	handleNotificationPreferencesUpdated: () => Promise<void>;
}) {
	const isVerifyingCode = ref(false);
	const isSendingVerification = ref(false);

	const parseResponsePayload = async (
		res: Response,
	): Promise<SmsVerificationPayload | null> => {
		try {
			return (await res.json()) as SmsVerificationPayload;
		} catch {
			return null;
		}
	};

	const updateLocalUserAfterVerificationSent = (formData: FormData) => {
		const phoneCountryCode = formData.get("phone_country_code");
		const phoneNumber = formData.get("phone_number");
		if (
			typeof phoneCountryCode !== "string" ||
			typeof phoneNumber !== "string"
		) {
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
			sms_notifications_enabled: true,
			verification_sent_at: new Date().toISOString(),
		} as User & { verification_sent_at: string };
	};

	const updateLocalUserAfterPhoneVerified = () => {
		options.user.value = {
			...options.user.value,
			phone_verified: true,
			verification_sent_at: null,
		} as User & { verification_sent_at: null };
		options.isEditingPhone.value = false;
	};

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

	const handleSmsVerificationSubmit = async (event: SubmitEvent) => {
		const submitter = event.submitter;
		const action =
			submitter instanceof HTMLElement
				? submitter.getAttribute("formaction")
				: null;
		const isVerifyCodeSubmission = action === "/api/auth/sms/verify-code";
		const isSendVerificationSubmission =
			action === "/api/auth/sms/send-verification";
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
