import { computed, onMounted, onUnmounted, type Ref, watch } from "vue";

export function usePendingSmsChanges(options: {
	userId: Ref<string>;
	smsEnabled: Ref<boolean>;
	phoneVerified: Ref<boolean>;
	isEditingPhone: Ref<boolean>;
	logger: {
		warn: (message: string, context: Record<string, unknown>) => void;
	};
}) {
	const pendingSmsStorageKey = computed(() => {
		return `pending_sms_enabled:${options.userId.value}`;
	});
	const hasPendingSmsChanges = computed(() => {
		return options.smsEnabled.value && !options.phoneVerified.value;
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

		if (options.phoneVerified.value && pendingSmsState === "true") {
			options.smsEnabled.value = true;
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
		} else if (options.isEditingPhone.value && pendingSmsState === "true") {
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
		if (options.phoneVerified.value && options.smsEnabled.value) {
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
