export type CircuitState = {
	failures: number;
	openUntilMs: number;
};

export const optionalVendorCircuits = new Map<string, CircuitState>();

export const optionalVendorSkipState = { count: 0 };
