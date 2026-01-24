export function findFormElement({
	formId,
	fallbackElement,
}: {
	formId?: string;
	fallbackElement?: HTMLElement | null;
}): HTMLFormElement | null {
	if (typeof formId === "string") {
		const trimmed = formId.trim();
		if (trimmed) {
			const byId = document.getElementById(trimmed);
			if (byId instanceof HTMLFormElement) {
				return byId;
			}
		}
	}

	if (fallbackElement) {
		const closest = fallbackElement.closest("form");
		if (closest instanceof HTMLFormElement) {
			return closest;
		}
	}

	return null;
}
