export const DASHBOARD_SECTION_IDS = {
	preferences: "notification-preferences",
	stocks: "tracked-stocks",
	scheduled: "scheduled-notifications",
	preview: "preview-notifications",
} as const;

export type DashboardSection = keyof typeof DASHBOARD_SECTION_IDS;

export const DASHBOARD_SECTION_HASHES: Record<DashboardSection, string> = {
	preferences: `#${DASHBOARD_SECTION_IDS.preferences}`,
	stocks: `#${DASHBOARD_SECTION_IDS.stocks}`,
	scheduled: `#${DASHBOARD_SECTION_IDS.scheduled}`,
	preview: `#${DASHBOARD_SECTION_IDS.preview}`,
};

type DashboardRedirectOptions = {
	success?: string;
	error?: string;
	warning?: string;
	section?: DashboardSection;
};

export function buildDashboardRedirect({
	success,
	error,
	warning,
	section,
}: DashboardRedirectOptions): string {
	const url = new URL("/dashboard", "http://localhost");
	if (success) url.searchParams.set("success", success);
	if (error) url.searchParams.set("error", error);
	if (warning) url.searchParams.set("warning", warning);
	const hash = section ? DASHBOARD_SECTION_HASHES[section] : "";
	return `${url.pathname}${url.search}${hash}`;
}

export function resolveDashboardSectionFromHash(
	hash: string,
): DashboardSection | null {
	if (!hash) return null;
	if (hash === DASHBOARD_SECTION_HASHES.preferences) return "preferences";
	if (hash === DASHBOARD_SECTION_HASHES.stocks) return "stocks";
	if (hash === DASHBOARD_SECTION_HASHES.scheduled) return "scheduled";
	if (hash === DASHBOARD_SECTION_HASHES.preview) return "preview";
	return null;
}
