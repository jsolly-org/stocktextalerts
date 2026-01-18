/* =============
Form Navigation Warning Utility
============= */

export function readFormValues(form: HTMLFormElement) {
	const values = new Map<string, string | boolean | null>();
	const elements = form.querySelectorAll("[name]");

	for (const element of elements) {
		const name = element.getAttribute("name");
		if (!name) continue;

		if (element instanceof HTMLInputElement) {
			if (element.type === "checkbox") {
				values.set(name, element.checked);
			} else if (element.type === "radio") {
				if (!values.has(name)) {
					values.set(name, null);
				}
				if (element.checked) {
					values.set(name, element.value);
				}
			} else {
				values.set(name, element.value);
			}
		} else if (
			element instanceof HTMLSelectElement ||
			element instanceof HTMLTextAreaElement
		) {
			values.set(name, element.value);
		}
	}

	return values;
}

export function setupFormNavigationWarning(options: {
	formId: string;
	saveButtonId: string;
	customDirtyCheck?: () => boolean;
	customSaveButtonCheck?: () => boolean;
}): (() => void) | undefined {
	const { formId, saveButtonId, customDirtyCheck, customSaveButtonCheck } =
		options;

	const formElement = document.getElementById(formId);
	if (!(formElement instanceof HTMLFormElement)) {
		return undefined;
	}
	const form = formElement;

	const saveButtonElement = document.getElementById(saveButtonId);
	if (!(saveButtonElement instanceof HTMLButtonElement)) {
		return undefined;
	}
	const saveButton = saveButtonElement;

	let isSubmitting = false;

	function clearSubmittingState() {
		isSubmitting = false;
	}

	let initialValues = readFormValues(form);

	function resetInitialValues() {
		initialValues = readFormValues(form);
		updateSaveButtonState();
	}

	function handleSubmitSuccess() {
		clearSubmittingState();
		resetInitialValues();
	}

	function checkIfDirty() {
		if (customDirtyCheck) {
			return customDirtyCheck();
		}

		const currentValues = readFormValues(form);
		const keys = new Set([...initialValues.keys(), ...currentValues.keys()]);
		for (const key of keys) {
			if (initialValues.get(key) !== currentValues.get(key)) {
				return true;
			}
		}
		return false;
	}

	function updateSaveButtonState() {
		if (customSaveButtonCheck) {
			saveButton.disabled = !customSaveButtonCheck();
		} else {
			saveButton.disabled = !checkIfDirty();
		}
	}

	function handleFormChange() {
		updateSaveButtonState();
	}

	function handleSubmit(event: SubmitEvent) {
		isSubmitting = true;

		queueMicrotask(() => {
			if (event.defaultPrevented) {
				clearSubmittingState();
			}
		});
	}

	function handleInvalid() {
		clearSubmittingState();
	}

	function handleBeforeUnload(event: BeforeUnloadEvent) {
		if (isSubmitting) {
			return;
		}
		const dirty = checkIfDirty();
		if (dirty) {
			event.preventDefault();
			event.returnValue = "";
			return "";
		}
	}

	form.addEventListener("input", handleFormChange);
	form.addEventListener("change", handleFormChange);
	form.addEventListener("submit", handleSubmit);
	form.addEventListener("submit:success", handleSubmitSuccess);
	form.addEventListener("submit:error", clearSubmittingState);
	form.addEventListener("invalid", handleInvalid, true);
	window.addEventListener("beforeunload", handleBeforeUnload);

	function shouldWarnOnLinkClick(link: HTMLAnchorElement): boolean {
		if (link.target === "_blank") {
			return false;
		}

		if (!checkIfDirty()) {
			return false;
		}

		const href = link.getAttribute("href");
		if (!href || href.startsWith("#") || href.startsWith("javascript:")) {
			return false;
		}

		try {
			const destination = new URL(link.href, window.location.href);
			const current = new URL(window.location.href);

			const isSamePage =
				destination.origin === current.origin &&
				destination.pathname === current.pathname &&
				destination.search === current.search;

			if (isSamePage) {
				return false;
			}
		} catch {
			return false;
		}

		return true;
	}

	function handleDocumentClick(event: Event) {
		const target = event.target;
		if (!(target instanceof Element)) {
			return;
		}

		const link = target.closest("a");
		if (!link || !shouldWarnOnLinkClick(link)) {
			return;
		}

		if (
			!confirm(
				"You have unsaved changes. Are you sure you want to leave this page?",
			)
		) {
			event.preventDefault();
			event.stopPropagation();
		}
	}

	document.addEventListener("click", handleDocumentClick, true);

	updateSaveButtonState();

	return () => {
		form.removeEventListener("input", handleFormChange);
		form.removeEventListener("change", handleFormChange);
		form.removeEventListener("submit", handleSubmit);
		form.removeEventListener("submit:success", handleSubmitSuccess);
		form.removeEventListener("submit:error", clearSubmittingState);
		form.removeEventListener("invalid", handleInvalid, true);
		window.removeEventListener("beforeunload", handleBeforeUnload);
		document.removeEventListener("click", handleDocumentClick, true);
	};
}
