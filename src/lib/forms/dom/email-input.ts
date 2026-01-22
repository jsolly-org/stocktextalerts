export function setupEmailInputHandlers(emailInput: HTMLInputElement) {
	emailInput.addEventListener("keydown", (e) => {
		if (e.key === " ") {
			e.preventDefault();
		}
	});

	emailInput.addEventListener("paste", (e) => {
		if (!e.clipboardData) return;
		e.preventDefault();
		const paste = e.clipboardData.getData("text").replace(/\s/g, "");

		const currentValue = emailInput.value;
		const selectionStart = emailInput.selectionStart ?? currentValue.length;
		const selectionEnd = emailInput.selectionEnd ?? currentValue.length;

		emailInput.value =
			currentValue.slice(0, selectionStart) +
			paste +
			currentValue.slice(selectionEnd);

		const caretPosition = selectionStart + paste.length;
		emailInput.selectionStart = caretPosition;
		emailInput.selectionEnd = caretPosition;
	});
}
