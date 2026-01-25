import { onBeforeUnmount, type Ref, ref, watch } from "vue";

import { rootLogger } from "../../../lib/logging";
import { formatMessage } from "../../../lib/status-messages";

/* ============= Types ============= */
type FormSaveResponse<T = unknown> = {
	ok: boolean;
	message: string;
	preferences?: T;
};

export type PreferencesData = {
	email_notifications_enabled: boolean;
	sms_notifications_enabled: boolean;
	sms_opted_out: boolean;
	phone_verified: boolean;
	timezone: string;
	daily_digest_enabled: boolean;
	daily_digest_notification_time: number;
	next_send_at: string | null;
	dismiss_timezone_mismatch_prompts: boolean;
};

type AutoSaveOptions = {
	formRef: Ref<HTMLFormElement | null>;
	debounceMs?: number;
	expectedActionPath?: string;
};

/* ============= Helpers ============= */
function resolveActionPath(
	form: HTMLFormElement,
	submitter: HTMLElement | null,
) {
	const submitAction =
		(submitter instanceof HTMLButtonElement ||
			submitter instanceof HTMLInputElement) &&
		submitter.formAction
			? submitter.formAction
			: form.action;
	const resolved = new URL(submitAction, window.location.href);
	return resolved.pathname;
}

function serializeFormData(formData: FormData): string {
	const entries: string[] = [];
	for (const [name, value] of formData.entries()) {
		const serializedValue =
			value instanceof File
				? `${value.name}:${value.size}:${value.lastModified}`
				: String(value);
		entries.push(`${name}=${serializedValue}`);
	}
	entries.sort();
	return entries.join("&");
}

/* ============= Composable ============= */
export function useAutoSaveForm<T = unknown>(options: AutoSaveOptions) {
	const statusMessage = ref<string | null>(null);
	const statusTone = ref<"error" | "info">("info");
	const isSaving = ref(false);
	const savedData = ref<T | null>(null);

	const debounceMs = options.debounceMs ?? 450;
	let debounceHandle: number | null = null;
	let pendingSave = false;
	const lastSavedSignature = ref<string | null>(null);
	const dirtySignal = ref(0);

	function setStatus(message: string | null, tone: "error" | "info" = "info") {
		statusMessage.value = message;
		if (message) {
			statusTone.value = tone;
		}
	}

	async function sendUpdate(
		form: HTMLFormElement,
		formData: FormData,
		submittedSignature: string,
	) {
		isSaving.value = true;
		setStatus("Saving...", "info");

		try {
			const response = await fetch(form.action, {
				method: "POST",
				body: formData,
				credentials: "same-origin",
				headers: { Accept: "application/json" },
				signal: AbortSignal.timeout(10_000),
			});

			const payload = (await response.json()) as FormSaveResponse<T>;

			if (!response.ok || !payload.ok) {
				const formattedMessage =
					payload && typeof payload.message === "string"
						? formatMessage(payload.message.trim())
						: "";
				const errorMessage =
					formattedMessage || "Could not save changes. Please try again.";
				setStatus(errorMessage, "error");
				return;
			}

			lastSavedSignature.value = submittedSignature;
			setStatus(null);
			savedData.value = (payload.preferences ?? null) as T | null;
		} catch (error) {
			if (error instanceof Error && error.name === "TimeoutError") {
				setStatus("Save timed out. Please try again.", "error");
			} else {
				setStatus("Could not save changes. Please try again.", "error");
			}
			rootLogger.error("Autosave failed for dashboard form", undefined, error);
		} finally {
			isSaving.value = false;
			if (pendingSave) {
				pendingSave = false;
				const currentForm = options.formRef.value;
				if (currentForm) {
					void triggerSave(currentForm);
				}
			}
		}
	}

	async function triggerSave(form: HTMLFormElement) {
		const formData = new FormData(form);
		const currentSignature = serializeFormData(formData);
		if (currentSignature === lastSavedSignature.value) {
			return;
		}
		if (isSaving.value) {
			pendingSave = true;
			return;
		}

		await sendUpdate(form, formData, currentSignature);
	}

	function scheduleSave(form: HTMLFormElement) {
		if (debounceHandle) {
			window.clearTimeout(debounceHandle);
			debounceHandle = null;
		}

		// Debounce autosave to batch rapid user input intentionally.
		debounceHandle = window.setTimeout(() => {
			void triggerSave(form);
		}, debounceMs);
	}

	function notifyChange() {
		dirtySignal.value += 1;
	}

	function handleFormInput() {
		dirtySignal.value += 1;
	}

	function handleFormChange() {
		dirtySignal.value += 1;
	}

	async function handleFormSubmit(event: SubmitEvent): Promise<void> {
		const form = options.formRef.value;
		if (!form) {
			return;
		}

		const submitter = event.submitter ?? null;
		const path = resolveActionPath(form, submitter);
		const expectedPath =
			options.expectedActionPath ??
			new URL(form.action, window.location.href).pathname;
		if (path !== expectedPath) {
			return;
		}

		event.preventDefault();
		await triggerSave(form);
	}

	watch(dirtySignal, () => {
		const form = options.formRef.value;
		if (!form) {
			return;
		}
		scheduleSave(form);
	});

	watch(
		() => options.formRef.value,
		(form) => {
			if (!form) {
				return;
			}
			lastSavedSignature.value = serializeFormData(new FormData(form));
		},
		{ immediate: true },
	);

	onBeforeUnmount(() => {
		if (debounceHandle) {
			window.clearTimeout(debounceHandle);
		}
	});

	return {
		handleFormChange,
		handleFormInput,
		handleFormSubmit,
		isSaving,
		notifyChange,
		savedData,
		statusMessage,
		statusTone,
	};
}
