import {
	type ComputedRef,
	computed,
	onMounted,
	onUnmounted,
	type Ref,
	ref,
} from "vue";
import { formatMessage } from "../../../../lib/constants";
import {
	formatCountdownWithSeconds,
	formatNextSendDateTime,
	getNowInTimezone,
	getSecondsUntilNextSend,
} from "../../../../lib/time/format";

type FlashTone = "success" | "error" | "warning";
type FlashMessage = { tone: FlashTone; message: string };

export function useFlashMessages(options: {
	flashMessages: Ref<FlashMessage[]>;
}) {
	const localFlashMessages = ref<FlashMessage[]>([]);
	const timers = new Map<FlashTone, number>();

	const allFlashMessages = computed(() => [
		...options.flashMessages.value,
		...localFlashMessages.value,
	]);

	function clearToneTimeout(tone: FlashTone) {
		const existingTimerId = timers.get(tone);
		if (existingTimerId === undefined) {
			return;
		}
		clearTimeout(existingTimerId);
		timers.delete(tone);
	}

	function dismissFlashMessage(tone: FlashTone) {
		clearToneTimeout(tone);

		const index = localFlashMessages.value.findIndex((f) => f.tone === tone);
		if (index >= 0) {
			localFlashMessages.value.splice(index, 1);
		}
	}

	function showFlashMessage(tone: FlashTone, messageKey: string) {
		const formatted = formatMessage(messageKey);
		const message = formatted !== "" ? formatted : messageKey;

		clearToneTimeout(tone);

		const existingIndex = localFlashMessages.value.findIndex(
			(f) => f.tone === tone,
		);
		const newMessage = { tone, message };

		if (existingIndex >= 0) {
			localFlashMessages.value[existingIndex] = newMessage;
		} else {
			localFlashMessages.value.push(newMessage);
		}

		const timeoutId = window.setTimeout(() => {
			const currentTimerId = timers.get(tone);
			if (currentTimerId !== timeoutId) {
				return;
			}
			timers.delete(tone);
			dismissFlashMessage(tone);
		}, 5000);
		timers.set(tone, timeoutId);
	}

	onUnmounted(() => {
		for (const timeoutId of timers.values()) {
			clearTimeout(timeoutId);
		}
		timers.clear();
	});

	return { allFlashMessages, dismissFlashMessage, showFlashMessage };
}

export function useScheduledDigestTiming(options: {
	timezone: ComputedRef<string>;
	dailyDigestEnabled: Ref<boolean>;
	nextSendAtIso: ComputedRef<string | null>;
	timeInput: ComputedRef<string | null>;
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

	const nextSendFormatted = computed(() => {
		if (!options.dailyDigestEnabled.value) {
			return null;
		}
		const at = options.nextSendAtIso.value;
		const tz = options.timezone.value;
		if (typeof at !== "string" || at === "" || tz === "") {
			return null;
		}
		const formatted = formatNextSendDateTime(at, tz);
		return formatted === "" ? null : formatted;
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
			timeInput: options.timeInput.value,
			timezone: tz,
		});
		if (secondsUntil === null) {
			return null;
		}
		if (secondsUntil <= 0) {
			return "Your next digest is due soon.";
		}
		return `in ${formatCountdownWithSeconds(secondsUntil)}`;
	});

	return { currentTimeInTimezone, nextSendFormatted, countdownText };
}
