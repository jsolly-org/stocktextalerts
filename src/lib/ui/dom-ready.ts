export function onDOMReady(callback: () => void) {
	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", callback, { once: true });
		return;
	}

	callback();
}
