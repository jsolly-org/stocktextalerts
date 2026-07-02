import { type ComputedRef, computed, onMounted, onUnmounted, ref, watch } from "vue";
import { formatCountdownWithSeconds, getSecondsUntilNextSend } from "../../../lib/time/display";
import { useHydrated } from "../../useHydrated";

// Defers time-dependent rendering until after mount to avoid hydration mismatches.
/** Provide derived UI state for scheduled update timing (local “now” and countdown). */
export function useScheduledUpdateTiming(options: {
	timezone: ComputedRef<string>;
	nextSendAtIso: ComputedRef<string | null>;
	timeInputs: ComputedRef<string[]>;
	is24?: ComputedRef<boolean>;
}) {
	const isHydrated = useHydrated();
	const tick = ref(0);
	const intervalId = ref<number | null>(null);
	const adjustedNextSendAtIso = ref<string | null>(null);
	const delayReasons = ref<Array<"weekend" | "holiday" | "half-day-after-close">>([]);
	const holidayName = ref<string | null>(null);
	const dstShift = ref<"spring-forward" | "fall-back" | null>(null);
	const refreshRequestId = ref(0);

	const refreshAdjustedNextSendAt = async () => {
		const requestId = refreshRequestId.value + 1;
		refreshRequestId.value = requestId;

		const tz = options.timezone.value;
		const inputs = options.timeInputs.value;
		if (inputs.length === 0) {
			adjustedNextSendAtIso.value = null;
			delayReasons.value = [];
			holidayName.value = null;
			dstShift.value = null;
			return;
		}

		const clearAdjustedIfActive = () => {
			// Only clear if this request is still the most recent one.
			if (refreshRequestId.value !== requestId) {
				return;
			}
			adjustedNextSendAtIso.value = null;
			delayReasons.value = [];
			holidayName.value = null;
			dstShift.value = null;
		};

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
				clearAdjustedIfActive();
				return;
			}
			const payload = (await response.json()) as {
				ok?: boolean;
				nextSendAtIso?: string | null;
				delayReasons?: Array<"weekend" | "holiday" | "half-day-after-close">;
				holidayName?: string | null;
				dstShift?: "spring-forward" | "fall-back" | null;
			};
			if (refreshRequestId.value !== requestId) {
				return;
			}
			if (payload.ok !== true) {
				clearAdjustedIfActive();
				return;
			}
			adjustedNextSendAtIso.value =
				typeof payload.nextSendAtIso === "string" ? payload.nextSendAtIso : null;
			delayReasons.value = Array.isArray(payload.delayReasons) ? payload.delayReasons : [];
			holidayName.value = typeof payload.holidayName === "string" ? payload.holidayName : null;
			dstShift.value =
				payload.dstShift === "spring-forward" || payload.dstShift === "fall-back"
					? payload.dstShift
					: null;
		} catch {
			clearAdjustedIfActive();
			// Best-effort enhancement only; countdown will fall back to persisted next_send_at.
		}
	};

	onMounted(() => {
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
			if (!isHydrated.value) {
				return;
			}
			void refreshAdjustedNextSendAt();
		},
	);

	const countdownText = computed(() => {
		if (!isHydrated.value) {
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
	const countdownDstShift = computed(() => dstShift.value);

	return {
		countdownText,
		countdownDelayReasons,
		countdownHolidayName,
		countdownDstShift,
	};
}
