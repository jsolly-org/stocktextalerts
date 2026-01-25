/* =============
hCaptcha Utility Functions
============= */

import { rootLogger } from "../logging";

type CallbackWindow<T> = Window & {
	[key: string]: T | undefined;
};

const isInputElement = (element: Element): element is HTMLInputElement =>
	element instanceof HTMLInputElement;

const isFormElement = (element: Element): element is HTMLFormElement =>
	element instanceof HTMLFormElement;

const isHtmlElement = (element: Element): element is HTMLElement =>
	element instanceof HTMLElement;

function resolveElement<T extends HTMLElement>(
	id: string,
	guard: (element: Element) => element is T,
) {
	const element = document.getElementById(id);
	if (!element || !guard(element)) {
		return null;
	}
	return element;
}

function resolveSubmitButton(
	form: HTMLFormElement,
): HTMLButtonElement | HTMLInputElement | null {
	const buttonSubmit = form.querySelector("button[type='submit']");
	if (buttonSubmit instanceof HTMLButtonElement) {
		return buttonSubmit;
	}

	const defaultButton = form.querySelector("button:not([type])");
	if (defaultButton instanceof HTMLButtonElement) {
		return defaultButton;
	}

	const inputSubmit = form.querySelector("input[type='submit']");
	if (inputSubmit instanceof HTMLInputElement) {
		return inputSubmit;
	}

	return null;
}

function onDomReady(callback: () => void) {
	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", callback, { once: true });
		return;
	}
	callback();
}

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
		const input = resolveElement(tokenInputId, isInputElement);
		if (!input) {
			return;
		}

		input.value = token;
		input.dispatchEvent(new Event("input", { bubbles: true }));
		handler?.(token);

		if (formId) {
			const form = resolveElement(formId, isFormElement);
			if (!form) {
				return;
			}

			const submitButton = resolveSubmitButton(form);
			if (!submitButton) {
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
			rootLogger.error("hCaptcha error", { errorCode });
		});
	setWindowCallback<(errorCode: string) => void>(callbackName, cb);
}

export function setupHCaptchaExpiredCallback(
	callbackName: string,
	tokenInputId: string,
	handler?: () => void,
) {
	setWindowCallback<() => void>(callbackName, () => {
		const input = resolveElement(tokenInputId, isInputElement);
		if (input) {
			input.value = "";
			input.dispatchEvent(new Event("input", { bubbles: true }));
		}

		handler?.();
	});
}

const captchaFormCleanups = new WeakMap<HTMLInputElement, () => void>();

export function initializeHCaptchaForm(formId: string, tokenInputId: string) {
	const setup = () => {
		const form = resolveElement(formId, isFormElement);
		if (!form) {
			return;
		}

		const captchaTokenInput = resolveElement(tokenInputId, isInputElement);
		if (!captchaTokenInput) {
			return;
		}

		const existingCleanup = captchaFormCleanups.get(captchaTokenInput);
		if (existingCleanup) {
			existingCleanup();
		}

		const submitButton = resolveSubmitButton(form);
		if (!submitButton) {
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

	onDomReady(setup);
}

export function setupCaptchaTokenInputListener(
	tokenInputId: string,
	handler: (token: string) => void,
) {
	const input = resolveElement(tokenInputId, isInputElement);
	if (!input) {
		return () => {};
	}

	const handleInput = () => {
		handler(input.value);
	};

	input.addEventListener("input", handleInput);

	return () => {
		input.removeEventListener("input", handleInput);
	};
}

export function setupCaptchaSubmitGuard(
	formId: string,
	tokenInputId: string,
	showStatus: (message: string) => void,
) {
	const form = resolveElement(formId, isFormElement);
	const tokenInput = resolveElement(tokenInputId, isInputElement);
	if (!form || !tokenInput) {
		return () => {};
	}

	const handleSubmit = (event: SubmitEvent) => {
		const captchaResponseInput = form.querySelector(
			"input[name='h-captcha-response']",
		);
		const captchaResponse =
			captchaResponseInput instanceof HTMLInputElement
				? captchaResponseInput.value
				: "";

		const existingToken = tokenInput.value.trim();
		const trimmedCaptchaResponse = captchaResponse.trim();

		if (existingToken.length === 0 && trimmedCaptchaResponse.length === 0) {
			event.preventDefault();
			showStatus("Please complete the CAPTCHA verification.");
			return;
		}

		if (existingToken.length === 0 && trimmedCaptchaResponse.length > 0) {
			tokenInput.value = trimmedCaptchaResponse;
		}
	};

	form.addEventListener("submit", handleSubmit);

	return () => {
		form.removeEventListener("submit", handleSubmit);
	};
}

export function createCaptchaStatusHelpers(statusElementId: string) {
	const statusElement = resolveElement(statusElementId, isHtmlElement);
	if (!statusElement) {
		rootLogger.warn("hCaptcha status element not found", {
			statusElementId,
		});
		return {
			show: (_message: string) => {},
			hide: () => {},
		};
	}

	return {
		show: (message: string) => {
			statusElement.textContent = message;
			statusElement.classList.remove("hidden");
		},
		hide: () => {
			statusElement.textContent = "";
			statusElement.classList.add("hidden");
		},
	};
}
