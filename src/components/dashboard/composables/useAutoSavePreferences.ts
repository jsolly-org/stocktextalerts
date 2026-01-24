import { type Ref, ref, watch } from "vue";

import { rootLogger } from "../../../lib/logging";
import { formatMessage } from "../../../lib/status-messages";

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
	formRef: Ref<HTMLFormElement | null>;
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

function snapshot(fd: FormData) {
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

function hasSnapshotChanged(
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

export function useAutoSavePreferences(options: AutoSaveOptions) {
	const statusMessage = ref<string | null>(null);
	const statusTone = ref<"error" | "info">("info");
	const isSaving = ref(false);
	const savedPreferences = ref<PreferencesResponse["preferences"] | null>(null);

	const debounceMs = options.debounceMs ?? 450;
	let queued = false;
	let pendingSnapshot: Map<string, string> | null = null;
	let initialSnapshot: Map<string, string> | null = null;
	let debounceHandle: number | null = null;

	function setStatus(message: string | null, tone: "error" | "info" = "info") {
		statusMessage.value = message;
		if (message) {
			statusTone.value = tone;
		}
	}

	async function sendUpdate(
		form: HTMLFormElement,
		submittedSnapshot: Map<string, string>,
	) {
		isSaving.value = true;
		setStatus("Saving...", "info");

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
				const formattedMessage =
					payload && typeof payload.message === "string"
						? formatMessage(payload.message.trim())
						: "";
				const errorMessage =
					formattedMessage || "Could not save changes. Please try again.";
				setStatus(errorMessage, "error");
				return;
			}

			if (debounceHandle) {
				window.clearTimeout(debounceHandle);
				debounceHandle = null;
			}

			initialSnapshot = submittedSnapshot;
			setStatus(null);
			savedPreferences.value = payload.preferences ?? null;
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
			isSaving.value = false;
			if (queued) {
				queued = false;
				const currentForm = options.formRef.value;
				const snapshotToSave =
					pendingSnapshot ??
					(currentForm ? snapshot(new FormData(currentForm)) : null);
				pendingSnapshot = null;
				if (currentForm && snapshotToSave) {
					void triggerSave(currentForm, snapshotToSave);
				}
			}
		}
	}

	async function triggerSave(
		form: HTMLFormElement,
		currentSnapshot: Map<string, string>,
	) {
		if (!initialSnapshot) {
			initialSnapshot = currentSnapshot;
		}
		if (!hasSnapshotChanged(currentSnapshot, initialSnapshot)) {
			return;
		}

		if (isSaving.value) {
			queued = true;
			pendingSnapshot = currentSnapshot;
			return;
		}

		await sendUpdate(form, currentSnapshot);
	}

	function scheduleSave(form: HTMLFormElement) {
		const currentSnapshot = snapshot(new FormData(form));
		if (!initialSnapshot) {
			initialSnapshot = currentSnapshot;
		}
		if (!hasSnapshotChanged(currentSnapshot, initialSnapshot)) {
			if (debounceHandle) {
				window.clearTimeout(debounceHandle);
				debounceHandle = null;
			}
			return;
		}

		if (isSaving.value) {
			queued = true;
			pendingSnapshot = currentSnapshot;
			return;
		}

		if (debounceHandle) {
			window.clearTimeout(debounceHandle);
			debounceHandle = null;
		}

		// Debounce autosave to batch rapid user input intentionally.
		debounceHandle = window.setTimeout(() => {
			void triggerSave(form, currentSnapshot);
		}, debounceMs);
	}

	function notifyChange() {
		const currentForm = options.formRef.value;
		if (!currentForm) {
			return;
		}
		scheduleSave(currentForm);
	}

	function handleFormInput() {
		const form = options.formRef.value;
		if (!form) {
			return;
		}
		scheduleSave(form);
	}

	function handleFormChange() {
		const form = options.formRef.value;
		if (!form) {
			return;
		}
		scheduleSave(form);
	}

	async function handleFormSubmit(event: SubmitEvent): Promise<void> {
		const form = options.formRef.value;
		if (!form) {
			return;
		}

		const submitter = event.submitter ?? null;
		const path = resolveActionPath(form, submitter);
		if (path !== "/api/preferences") {
			return;
		}

		event.preventDefault();
		const currentSnapshot = snapshot(new FormData(form));
		await triggerSave(form, currentSnapshot);
	}

	watch(
		() => options.formRef.value,
		(form, previousForm) => {
			if (previousForm && form !== previousForm) {
				initialSnapshot = null;
				pendingSnapshot = null;
				queued = false;
			}
			if (form && !initialSnapshot) {
				initialSnapshot = snapshot(new FormData(form));
			}
		},
		{ immediate: true },
	);

	return {
		handleFormChange,
		handleFormInput,
		handleFormSubmit,
		isSaving,
		notifyChange,
		savedPreferences,
		statusMessage,
		statusTone,
		triggerSave,
	};
}
