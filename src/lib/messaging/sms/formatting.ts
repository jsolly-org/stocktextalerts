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
