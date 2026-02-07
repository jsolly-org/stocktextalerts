import { type InjectionKey, inject, provide, type Ref } from "vue";

export interface SmsVerificationContext {
	isEditingPhone: Ref<boolean>;
	smsSuccessMessage: Ref<string | null>;
	sendVerificationDisabled: Ref<boolean>;
	isVerifyingCode: Ref<boolean>;
	isSendingVerification: Ref<boolean>;
}

const SMS_VERIFICATION_KEY: InjectionKey<SmsVerificationContext> =
	Symbol("sms-verification");

/**
 * Provide SMS verification state to descendant components.
 * Call once in NotificationChannelsPanel.
 */
export function provideSmsVerificationContext(
	context: SmsVerificationContext,
): void {
	provide(SMS_VERIFICATION_KEY, context);
}

/**
 * Inject SMS verification state from an ancestor provider.
 * Eliminates prop drilling through intermediate components.
 */
export function useSmsVerificationContext(): SmsVerificationContext {
	const context = inject(SMS_VERIFICATION_KEY);
	if (!context) {
		throw new Error(
			"useSmsVerificationContext() requires provideSmsVerificationContext() in an ancestor component",
		);
	}
	return context;
}
