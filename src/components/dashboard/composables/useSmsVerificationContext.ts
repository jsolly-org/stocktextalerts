import { type InjectionKey, inject, provide, type Ref } from "vue";

interface SmsVerificationContext {
	isEditingPhone: Ref<boolean>;
	smsSuccessMessage: Ref<string | null>;
	sendVerificationDisabled: Ref<boolean>;
	isVerifyingCode: Ref<boolean>;
	isSendingVerification: Ref<boolean>;
}

const SMS_VERIFICATION_KEY: InjectionKey<SmsVerificationContext> = Symbol("sms-verification");

/**
 * Provide shared SMS verification UI state for descendant components.
 */
export function provideSmsVerificationContext(context: SmsVerificationContext): void {
	provide(SMS_VERIFICATION_KEY, context);
}

/**
 * Consume the provided SMS verification context.
 *
 * Throws when called outside a component tree that has run `provideSmsVerificationContext()`.
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
