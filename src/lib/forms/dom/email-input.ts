export function setupEmailInputHandlers(emailInput: HTMLInputElement) {
	const handleKeydown = (event: KeyboardEvent) => {
		if (event.key === " ") {
			event.preventDefault();
		}
	};

	const handlePaste = (event: ClipboardEvent) => {
		if (!event.clipboardData) {
			return;
		}
		event.preventDefault();
		const paste = event.clipboardData.getData("text").replace(/\s/g, "");

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
	};

	emailInput.addEventListener("keydown", handleKeydown);
	emailInput.addEventListener("paste", handlePaste);

	return () => {
		emailInput.removeEventListener("keydown", handleKeydown);
		emailInput.removeEventListener("paste", handlePaste);
	};
}
