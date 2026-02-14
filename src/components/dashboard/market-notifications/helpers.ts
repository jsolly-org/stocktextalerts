import {
	type ComputedRef,
	computed,
	onMounted,
	onUnmounted,
	ref,
	watch,
} from "vue";
import {
	formatCountdownWithSeconds,
	getNowInTimezone,
	getSecondsUntilNextSend,
} from "../../../lib/time/format";

// Defers time-dependent rendering until after mount to avoid hydration mismatches.
/**
 * Provide derived UI state for scheduled update timing (local "now" and countdown).
 *
 * Uses a 1-second tick after mount to keep countdown text updated without hydration mismatch.
 */
export function useScheduledUpdateTiming(options: {
	timezone: ComputedRef<string>;
	nextSendAtIso: ComputedRef<string | null>;
	timeInputs: ComputedRef<string[]>;
	is24?: ComputedRef<boolean>;
}) {
	const hasMounted = ref(false);
	const tick = ref(0);
	const intervalId = ref<number | null>(null);
	const adjustedNextSendAtIso = ref<string | null>(null);
	const delayReasons = ref<Array<"weekend" | "holiday">>([]);
	const holidayName = ref<string | null>(null);
	const refreshRequestId = ref(0);

	const refreshAdjustedNextSendAt = async () => {
		const tz = options.timezone.value;
		const inputs = options.timeInputs.value;
		if (tz === "" || inputs.length === 0) {
			adjustedNextSendAtIso.value = null;
			delayReasons.value = [];
			holidayName.value = null;
			return;
		}

		const requestId = refreshRequestId.value + 1;
		refreshRequestId.value = requestId;
		try {
			const response = await fetch("/api/market-notifications/next-send-at", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					timezone: tz,
					timeInputs: inputs,
				}),
			});
			if (!response.ok) {
				return;
			}
			const payload = (await response.json()) as {
				ok?: boolean;
				nextSendAtIso?: string | null;
				delayReasons?: Array<"weekend" | "holiday">;
				holidayName?: string | null;
			};
			if (refreshRequestId.value !== requestId || payload.ok !== true) {
				return;
			}
			adjustedNextSendAtIso.value =
				typeof payload.nextSendAtIso === "string"
					? payload.nextSendAtIso
					: null;
			delayReasons.value = Array.isArray(payload.delayReasons)
				? payload.delayReasons
				: [];
			holidayName.value =
				typeof payload.holidayName === "string" ? payload.holidayName : null;
		} catch {
			// Best-effort enhancement only; countdown will fall back to persisted next_send_at.
		}
	};

	onMounted(() => {
		hasMounted.value = true;
		tick.value = Date.now();
		intervalId.value = window.setInterval(() => {
			tick.value = Date.now();
		}, 1000);
		void refreshAdjustedNextSendAt();
	});
	onUnmounted(() => {
		if (intervalId.value === null) {
			return;
		}
		clearInterval(intervalId.value);
		intervalId.value = null;
	});

	watch(
		[
			() => options.timezone.value,
			() => options.nextSendAtIso.value,
			() => options.timeInputs.value.join(","),
		],
		() => {
			if (!hasMounted.value) {
				return;
			}
			void refreshAdjustedNextSendAt();
		},
	);

	const currentTimeInTimezone = computed(() => {
		if (!hasMounted.value) {
			return null;
		}
		void tick.value;
		const tz = options.timezone.value;
		return tz !== "" ? getNowInTimezone(tz, options.is24?.value) : null;
	});

	const countdownText = computed(() => {
		if (!hasMounted.value) {
			return null;
		}
		void tick.value;
		const tz = options.timezone.value;
		const secondsUntil = getSecondsUntilNextSend({
			nextSendAtIso: adjustedNextSendAtIso.value ?? options.nextSendAtIso.value,
			timeInputs: options.timeInputs.value,
			timezone: tz,
		});
		if (secondsUntil === null) {
			return null;
		}
		if (secondsUntil <= 0) {
			return "is due soon";
		}
		return `in ${formatCountdownWithSeconds(secondsUntil)}`;
	});

	const countdownDelayReasons = computed(() => delayReasons.value);
	const countdownHolidayName = computed(() => holidayName.value);

	return {
		currentTimeInTimezone,
		countdownText,
		countdownDelayReasons,
		countdownHolidayName,
	};
}
