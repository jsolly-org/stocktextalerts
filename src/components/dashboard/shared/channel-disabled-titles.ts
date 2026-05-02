export function getEmailChannelDisabledTitle(emailEnabled: boolean): string | undefined {
	if (emailEnabled) return undefined;
	return "Enable email in your notification channels to select this option.";
}

interface SmsChannelState {
	smsNotificationsEnabled: boolean;
	phoneVerified: boolean;
	smsOptedOut: boolean;
}

export function getSmsChannelDisabledTitle(state: SmsChannelState): string | undefined {
	// Opt-out is checked before phone-verification: a user who explicitly
	// stopped messages should see re-subscribe instructions even if their
	// phone is also unverified, since the opt-out is the actionable state.
	if (state.smsOptedOut) {
		return "You've opted out of SMS. Text START to your verified number to re-subscribe.";
	}
	if (!state.smsNotificationsEnabled) {
		return "Enable SMS in your notification channels to select this option.";
	}
	if (!state.phoneVerified) {
		return "Verify your phone number in notification channels to select this option.";
	}
	return undefined;
}
