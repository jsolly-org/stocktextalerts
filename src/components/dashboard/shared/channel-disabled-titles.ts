export function getEmailChannelDisabledTitle(emailEnabled: boolean): string | undefined {
	if (emailEnabled) return undefined;
	return "Enable email in your notification channels to select this option.";
}
