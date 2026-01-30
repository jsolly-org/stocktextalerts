import {
	type ComputedRef,
	computed,
	onMounted,
	onUnmounted,
	type Ref,
	ref,
} from "vue";
import type { FlashMessage } from "../../../../lib/constants";
import {
	formatCountdownWithSeconds,
	getNowInTimezone,
	getSecondsUntilNextSend,
} from "../../../../lib/time/format";

export function useFlashMessages(options: {
	flashMessages: Ref<FlashMessage[]>;
}) {
	const allFlashMessages = computed(() => options.flashMessages.value);
	return { allFlashMessages };
}

export function useScheduledDigestTiming(options: {
	timezone: ComputedRef<string>;
	dailyDigestEnabled: Ref<boolean>;
	nextSendAtIso: ComputedRef<string | null>;
	timeInputs: ComputedRef<string[]>;
}) {
	const tick = ref(Date.now());
	const intervalId = ref<number | null>(null);

	onMounted(() => {
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

	const currentTimeInTimezone = computed(() => {
		// Touch tick to recompute every second for the live clock.
		tick.value;
		const tz = options.timezone.value;
		return tz !== "" ? getNowInTimezone(tz) : null;
	});

	const countdownText = computed(() => {
		// Touch tick to recompute every second for the countdown.
		tick.value;
		if (!options.dailyDigestEnabled.value) {
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
