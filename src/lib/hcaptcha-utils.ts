/* =============
hCaptcha Utility Functions
============= */

type CallbackWindow<T> = Window & {
	[key: string]: T | undefined;
};

function setWindowCallback<T>(callbackName: string, callback: T) {
	const typedWindow = window as unknown as CallbackWindow<T>;
	typedWindow[callbackName] = callback;
}

export function setupHCaptchaCallback(
	callbackName: string,
	tokenInputId: string,
	formId?: string,
	handler?: (token: string) => void,
) {
	setWindowCallback<(token: string) => void>(callbackName, (token: string) => {
		const input = document.getElementById(tokenInputId);
		if (!(input instanceof HTMLInputElement)) {
			return;
		}

		input.value = token;
		input.dispatchEvent(new Event("input", { bubbles: true }));
		handler?.(token);

		if (formId) {
			const form = document.getElementById(formId);
			if (!(form instanceof HTMLFormElement)) {
				return;
			}

			const submitButton = form.querySelector("button[type='submit']");
			if (!(submitButton instanceof HTMLButtonElement)) {
				return;
			}

			submitButton.disabled = false;
		}
	});
}

export function setupHCaptchaErrorCallback(
	callbackName: string,
	handler?: (errorCode: string) => void,
) {
	const cb =
		handler ||
		((errorCode: string) => {
			console.error("hCaptcha error:", errorCode);
		});
	setWindowCallback<(errorCode: string) => void>(callbackName, cb);
}

export function setupHCaptchaExpiredCallback(
	callbackName: string,
	tokenInputId: string,
	handler?: () => void,
) {
	setWindowCallback<() => void>(callbackName, () => {
		const input = document.getElementById(tokenInputId);
		if (input instanceof HTMLInputElement) {
			input.value = "";
			input.dispatchEvent(new Event("input", { bubbles: true }));
		}

		handler?.();
	});
}

const captchaFormCleanups = new WeakMap<HTMLInputElement, () => void>();

export function initializeHCaptchaForm(formId: string, tokenInputId: string) {
	const setup = () => {
		const form = document.getElementById(formId);
		if (!(form instanceof HTMLFormElement)) {
			return;
		}

		const captchaTokenInput = document.getElementById(tokenInputId);
		if (!(captchaTokenInput instanceof HTMLInputElement)) {
			return;
		}

		const existingCleanup = captchaFormCleanups.get(captchaTokenInput);
		if (existingCleanup) {
			existingCleanup();
		}

		const submitButton = form.querySelector("button[type='submit']");
		if (!(submitButton instanceof HTMLButtonElement)) {
			return;
		}

		const updateDisabledState = () => {
			const hasToken = captchaTokenInput.value.trim().length > 0;
			submitButton.disabled = !hasToken;
		};

		updateDisabledState();

		captchaTokenInput.addEventListener("input", updateDisabledState);

		const cleanup = () => {
			captchaTokenInput.removeEventListener("input", updateDisabledState);
			captchaFormCleanups.delete(captchaTokenInput);
		};

		captchaFormCleanups.set(captchaTokenInput, cleanup);
	};

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", setup);
	} else {
		setup();
	}
}

export function createCaptchaStatusHelpers(statusElementId: string) {
	const statusElement = document.getElementById(statusElementId);

	return {
		show: (message: string) => {
			if (!(statusElement instanceof HTMLElement)) {
				return;
			}

			statusElement.textContent = message;
			statusElement.classList.remove("hidden");
		},
		hide: () => {
			if (!(statusElement instanceof HTMLElement)) {
				return;
			}

			statusElement.textContent = "";
			statusElement.classList.add("hidden");
		},
	};
}
