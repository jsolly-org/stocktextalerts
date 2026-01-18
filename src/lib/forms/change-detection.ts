export function snapshot(fd: FormData) {
	const values = new Map<string, string>();
	const keys = new Set<string>();
	for (const [name] of fd.entries()) keys.add(String(name));
	for (const name of keys) {
		values.set(
			name,
			fd
				.getAll(name)
				.map((item) =>
					item instanceof File
						? `${item.name}:${item.size}:${item.lastModified}`
						: String(item),
				)
				.join("\u0000"),
		);
	}
	return values;
}

export function hasSnapshotChanged(
	current: Map<string, string>,
	initial: Map<string, string>,
): boolean {
	if (current.size !== initial.size) {
		return true;
	}
	for (const [name, value] of current.entries()) {
		if (value !== initial.get(name)) {
			return true;
		}
	}
	return false;
}

export function setupFormChangeDetection(
	form: HTMLFormElement,
	saveButton: HTMLButtonElement,
) {
	// Note: initialValues is mutated on successful submit
	const initialValues = snapshot(new FormData(form));

	function updateInitialValues() {
		initialValues.clear();
		for (const [k, v] of snapshot(new FormData(form)).entries()) {
			initialValues.set(k, v);
		}
	}

	function checkFormChanged() {
		const currentValues = snapshot(new FormData(form));
		saveButton.disabled = !hasSnapshotChanged(currentValues, initialValues);
	}

	checkFormChanged();

	form.addEventListener("change", checkFormChanged);
	form.addEventListener("input", checkFormChanged);

	form.addEventListener("submit", (event) => {
		saveButton.disabled = true;

		// If another handler cancels submission, restore the correct enabled state.
		queueMicrotask(() => {
			if (event.defaultPrevented) {
				checkFormChanged();
			}
		});
	});

	form.addEventListener("submit:success", () => {
		updateInitialValues();
		checkFormChanged();
	});

	form.addEventListener("submit:error", () => {
		checkFormChanged();
	});
}
