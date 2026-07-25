/** Direction of a price move relative to a baseline: 1 up, -1 down, 0 flat. */
export type PriceMoveDirection = -1 | 0 | 1;

/** Sign of (price - baseline). */
export function priceMoveDirection(price: number, baseline: number): PriceMoveDirection {
	if (price > baseline) return 1;
	if (price < baseline) return -1;
	return 0;
}

/**
 * Effective threshold for a flat price-move evaluation.
 *
 * First-of-day and reverse moves use the full configured value. Same-direction
 * re-triggers (acceleration) use half. Legacy rows with a null stored direction
 * stay on the full threshold until the next finalize writes one.
 */
export function effectivePriceMoveThreshold(options: {
	configuredValue: number;
	isReTrigger: boolean;
	lastAlertDirection: PriceMoveDirection | null;
	moveDirection: PriceMoveDirection;
}): { value: number; isAcceleration: boolean } {
	const { configuredValue, isReTrigger, lastAlertDirection, moveDirection } = options;
	const isAcceleration =
		isReTrigger &&
		lastAlertDirection !== null &&
		moveDirection !== 0 &&
		moveDirection === lastAlertDirection;
	return {
		value: isAcceleration ? configuredValue / 2 : configuredValue,
		isAcceleration,
	};
}
