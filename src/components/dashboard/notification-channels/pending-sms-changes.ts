import { computed, onMounted, onUnmounted, type Ref, watch } from "vue";

/**
 * Track "pending SMS enabled" intent across refreshes while phone verification is in progress.
 *
 * This prevents a user from losing their intent to enable SMS if the server cannot persist the
 * preference until the phone is verified.
 */
export function usePendingSmsChanges(options: {
	userId: Ref<string>;
	smsEnabled: Ref<boolean>;
	phoneVerified: Ref<boolean>;
	serverSmsEnabled: Ref<boolean>;
	isEditingPhone: Ref<boolean>;
	logger: {
		warn: (message: string, context: Record<string, unknown>) => void;
	};
}) {
	const pendingSmsStorageKey = computed(() => {
		return `pending_sms_enabled:${options.userId.value}`;
	});
	const hasPendingSmsChanges = computed(() => {
		// "pending" means the user wants SMS on, but we're not yet in the persisted state.
		// - If the phone isn't verified yet, the SMS enable can't be saved.
		// - If the phone is verified but the server still has SMS disabled, keep treating
		//   this as pending so a refresh doesn't lose the user's intent.
		return (
			options.smsEnabled.value &&
			(!options.phoneVerified.value || !options.serverSmsEnabled.value)
		);
	});

	function savePendingSmsState() {
		if (typeof window === "undefined") return;
		try {
			if (hasPendingSmsChanges.value) {
				sessionStorage.setItem(pendingSmsStorageKey.value, "true");
			} else {
				sessionStorage.removeItem(pendingSmsStorageKey.value);
			}
		} catch (error) {
			options.logger.warn(
				"Unable to update session storage for pending SMS changes.",
				{
					storageKey: pendingSmsStorageKey.value,
					error,
				},
			);
		}
	}

	function restorePendingSmsState() {
		if (typeof window === "undefined") return;
		let pendingSmsState: string | null = null;
		try {
			pendingSmsState = sessionStorage.getItem(pendingSmsStorageKey.value);
		} catch (error) {
			options.logger.warn(
				"Unable to read session storage for pending SMS changes.",
				{
					storageKey: pendingSmsStorageKey.value,
					error,
				},
			);
			return;
		}

		if (pendingSmsState !== "true") {
			return;
		}

		if (options.phoneVerified.value) {
			options.smsEnabled.value = true;
			if (!options.serverSmsEnabled.value) {
				// Keep sessionStorage until we see the server persist SMS enabled.
				return;
			}

			try {
				sessionStorage.removeItem(pendingSmsStorageKey.value);
			} catch (error) {
				options.logger.warn(
					"Unable to clear session storage for pending SMS changes.",
					{
						storageKey: pendingSmsStorageKey.value,
						error,
					},
				);
			}
			return;
		}

		if (options.isEditingPhone.value) {
			// Restore pending SMS state when entering change phone mode
			options.smsEnabled.value = true;
		}
	}

	function setupNavigationWarning() {
		if (!hasPendingSmsChanges.value) {
			return;
		}

		function handleBeforeUnload(event: BeforeUnloadEvent) {
			event.preventDefault();
			event.returnValue = "";
			return "";
		}

		window.addEventListener("beforeunload", handleBeforeUnload);

		return () => {
			window.removeEventListener("beforeunload", handleBeforeUnload);
		};
	}

	let cleanupNavigationWarning: (() => void) | undefined;

	watch(hasPendingSmsChanges, () => {
		savePendingSmsState();
	});

	watch(
		[options.phoneVerified, options.isEditingPhone],
		([isVerified, editingPhone]) => {
			if (isVerified || editingPhone) {
				restorePendingSmsState();
			}
		},
		{ immediate: true },
	);

	onMounted(() => {
		if (
			options.phoneVerified.value &&
			options.smsEnabled.value &&
			options.serverSmsEnabled.value
		) {
			try {
				sessionStorage.removeItem(pendingSmsStorageKey.value);
			} catch (error) {
				options.logger.warn(
					"Unable to clear session storage for pending SMS changes.",
					{
						storageKey: pendingSmsStorageKey.value,
						error,
					},
				);
			}
		}

		cleanupNavigationWarning = setupNavigationWarning();
	});

	watch(hasPendingSmsChanges, (hasPending) => {
		if (cleanupNavigationWarning) {
			cleanupNavigationWarning();
		}
		if (hasPending) {
			cleanupNavigationWarning = setupNavigationWarning();
		} else {
			cleanupNavigationWarning = undefined;
		}
	});

	onUnmounted(() => {
		if (cleanupNavigationWarning) {
			cleanupNavigationWarning();
		}
	});

	return { hasPendingSmsChanges };
}
