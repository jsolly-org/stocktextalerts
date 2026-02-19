export function prefersReducedMotion(): boolean {
	if (typeof window === "undefined") return false;
	if (typeof window.matchMedia !== "function") return false;
	return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function getScrollBehavior(): ScrollBehavior {
	if (typeof window === "undefined") return "auto";
	return prefersReducedMotion() ? "auto" : "smooth";
}
