/**
 * Format an optional "extras" section (e.g. news/rumors) for SMS messages.
 *
 * Returns an empty string when `content` is blank.
 */
export function formatExtrasSection(
	title: string,
	content: string | null | undefined,
): string {
	const normalized = (content ?? "").trim();
	if (!normalized) {
		return "";
	}
	return `${title}\n${normalized}`;
}
