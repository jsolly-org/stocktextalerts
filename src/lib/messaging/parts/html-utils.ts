/** Escape HTML special characters for safe embedding in email templates. */
export function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

// Only allows http: and https: schemes to prevent javascript:, data:, and similar XSS.
export function getSafeHrefUrl(url: string): string | null {
	if (typeof url !== "string" || url.trim() === "") return null;
	const trimmed = url.trim().toLowerCase();
	if (trimmed.startsWith("https://") || trimmed.startsWith("http://")) {
		return url.trim();
	}
	return null;
}
