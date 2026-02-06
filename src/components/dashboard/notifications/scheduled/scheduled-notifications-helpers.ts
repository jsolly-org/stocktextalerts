import {
	type ComputedRef,
	computed,
	onMounted,
	onUnmounted,
	type Ref,
	ref,
} from "vue";
import {
	formatCountdownWithSeconds,
	getNowInTimezone,
	getSecondsUntilNextSend,
} from "../../../../lib/time/format";

/**
 * Keep live "current time" and "next send" countdown labels updated on the schedule panel.
 * Defers time-dependent rendering until after mount to avoid hydration mismatches.
 */
export function useScheduledUpdateTiming(options: {
	timezone: ComputedRef<string>;
	scheduledUpdatesEnabled: Ref<boolean>;
	nextSendAtIso: ComputedRef<string | null>;
	timeInputs: ComputedRef<string[]>;
}) {
	const hasMounted = ref(false);
	const tick = ref(0);
	const intervalId = ref<number | null>(null);

	onMounted(() => {
		hasMounted.value = true;
		tick.value = Date.now();
		intervalId.value = window.setInterval(() => {
			tick.value = Date.now();
		}, 1000);
	});
	onUnmounted(() => {
		if (intervalId.value === null) {
			return;
		}
		clearInterval(intervalId.value);
		intervalId.value = null;
	});

	// Defer live time/countdown until after mount so server and client initial render match (avoids hydration mismatch).
	const currentTimeInTimezone = computed(() => {
		if (!hasMounted.value) {
			return null;
		}
		void tick.value;
		const tz = options.timezone.value;
		return tz !== "" ? getNowInTimezone(tz) : null;
	});

	const countdownText = computed(() => {
		if (!hasMounted.value) {
			return null;
		}
		void tick.value;
		if (!options.scheduledUpdatesEnabled.value) {
			return null;
		}
		const tz = options.timezone.value;
		const secondsUntil = getSecondsUntilNextSend({
			nextSendAtIso: options.nextSendAtIso.value,
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

	return { currentTimeInTimezone, countdownText };
}
