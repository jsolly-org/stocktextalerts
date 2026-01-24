import { rootLogger } from "../../logging";
import { hasSnapshotChanged, snapshot } from "./change-detection";

type PreferencesResponse = {
	ok: boolean;
	message: string;
	preferences?: {
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
};

type AutoSaveOptions = {
	formId: string;
	statusId?: string;
	debounceMs?: number;
};

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

function formDataFromSnapshot(values: Map<string, string>) {
	const formData = new FormData();
	for (const [name, serializedValue] of values.entries()) {
		const parts = serializedValue.split("\u0000");
		for (const part of parts) {
			formData.append(name, part);
		}
	}
	return formData;
}

export function setupAutoSavePreferences(options: AutoSaveOptions) {
	const formElement = document.getElementById(options.formId);
	if (!(formElement instanceof HTMLFormElement)) {
		return;
	}

	const form = formElement;
	const statusElement = options.statusId
		? document.getElementById(options.statusId)
		: null;
	const debounceMs = options.debounceMs ?? 450;
	let isSaving = false;
	let queued = false;
	let pendingSnapshot: Map<string, string> | null = null;
	let initialSnapshot = snapshot(new FormData(form));
	let debounceHandle: number | null = null;

	function setStatus(message: string | null, tone: "error" | "info" = "info") {
		if (!(statusElement instanceof HTMLElement)) {
			return;
		}

		if (!message) {
			statusElement.textContent = "";
			statusElement.classList.add("hidden");
			return;
		}

		statusElement.textContent = message;
		statusElement.classList.remove("hidden");
		statusElement.dataset.tone = tone;
	}

	async function sendUpdate(submittedSnapshot: Map<string, string>) {
		isSaving = true;
		setStatus(null);

		try {
			const submittedFormData = formDataFromSnapshot(submittedSnapshot);
			const response = await fetch(form.action, {
				method: "POST",
				body: submittedFormData,
				credentials: "same-origin",
				headers: { Accept: "application/json" },
				signal: AbortSignal.timeout(10_000),
			});

			const payload = (await response.json()) as PreferencesResponse;

			if (!response.ok || !payload.ok) {
				setStatus("Could not save changes. Please try again.", "error");
				return;
			}

			initialSnapshot = submittedSnapshot;
			document.dispatchEvent(
				new CustomEvent("preferences-updated", {
					detail: payload,
				}),
			);
		} catch (error) {
			if (error instanceof Error && error.name === "TimeoutError") {
				setStatus("Save timed out. Please try again.", "error");
			} else {
				setStatus("Could not save changes. Please try again.", "error");
			}
			rootLogger.error(
				"Autosave failed for dashboard preferences",
				undefined,
				error,
			);
		} finally {
			isSaving = false;
			if (queued) {
				queued = false;
				if (pendingSnapshot) {
					void triggerSave(pendingSnapshot);
				} else {
					void triggerSave(snapshot(new FormData(form)));
				}
			}
		}
	}

	async function triggerSave(currentSnapshot: Map<string, string>) {
		if (!hasSnapshotChanged(currentSnapshot, initialSnapshot)) {
			return;
		}

		if (isSaving) {
			queued = true;
			pendingSnapshot = currentSnapshot;
			return;
		}

		await sendUpdate(currentSnapshot);
	}

	function handleChange() {
		if (debounceHandle) {
			window.clearTimeout(debounceHandle);
			debounceHandle = null;
		}

		const currentSnapshot = snapshot(new FormData(form));
		if (!hasSnapshotChanged(currentSnapshot, initialSnapshot)) {
			return;
		}

		// Debounce autosave to batch rapid user input intentionally.
		debounceHandle = window.setTimeout(() => {
			void triggerSave(currentSnapshot);
		}, debounceMs);
	}

	function handleSubmit(event: SubmitEvent) {
		const submitter = event.submitter ?? null;
		const path = resolveActionPath(form, submitter);
		if (path !== "/api/preferences") {
			return;
		}

		event.preventDefault();
		const currentSnapshot = snapshot(new FormData(form));
		void triggerSave(currentSnapshot);
	}

	form.addEventListener("input", handleChange);
	form.addEventListener("change", handleChange);
	form.addEventListener("submit", handleSubmit);

	const cleanup = () => {
		form.removeEventListener("input", handleChange);
		form.removeEventListener("change", handleChange);
		form.removeEventListener("submit", handleSubmit);
		if (debounceHandle) {
			window.clearTimeout(debounceHandle);
		}
	};

	window.addEventListener("pagehide", cleanup, { once: true });
}
