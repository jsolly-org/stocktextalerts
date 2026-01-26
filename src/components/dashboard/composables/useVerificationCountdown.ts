import { computed, onUnmounted, ref } from "vue";

const VERIFICATION_EXPIRATION_MINUTES = 10;
const VERIFICATION_EXPIRATION_MS = VERIFICATION_EXPIRATION_MINUTES * 60 * 1000;

export function useVerificationCountdown(
	verificationSentAt: string | null | undefined,
) {
	const now = ref(Date.now());
	let intervalId: ReturnType<typeof setInterval> | null = null;

	const startTime = verificationSentAt
		? new Date(verificationSentAt).getTime()
		: null;
	const endTime = startTime ? startTime + VERIFICATION_EXPIRATION_MS : null;

	const timeRemaining = computed(() => {
		if (!endTime) {
			return 0;
		}
		const remaining = endTime - now.value;
		return Math.max(0, remaining);
	});

	const secondsRemaining = computed(() => {
		return Math.ceil(timeRemaining.value / 1000);
	});

	const minutesRemaining = computed(() => {
		return Math.floor(secondsRemaining.value / 60);
	});

	const secondsDisplay = computed(() => {
		return secondsRemaining.value % 60;
	});

	const isExpired = computed(() => {
		return timeRemaining.value === 0;
	});

	const canResend = computed(() => {
		return isExpired.value;
	});

	const formattedTime = computed(() => {
		if (isExpired.value) {
			return "0:00";
		}
		return `${minutesRemaining.value}:${secondsDisplay.value.toString().padStart(2, "0")}`;
	});

	if (verificationSentAt && endTime && endTime > Date.now()) {
		intervalId = setInterval(() => {
			now.value = Date.now();
			if (isExpired.value && intervalId) {
				clearInterval(intervalId);
				intervalId = null;
			}
		}, 1000);
	}

	onUnmounted(() => {
		if (intervalId) {
			clearInterval(intervalId);
		}
	});

	return {
		timeRemaining,
		secondsRemaining,
		minutesRemaining,
		secondsDisplay,
		isExpired,
		canResend,
		formattedTime,
	};
}
