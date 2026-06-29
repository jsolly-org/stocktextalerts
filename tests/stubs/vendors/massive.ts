/** No-op Massive vendor module for MODE=test Astro servers (E2E / HTTP tests). */

type MarketDataFetchPolicy = {
	maxRetries?: number;
	requestTimeoutMs?: number;
	optional?: boolean;
};

export async function marketDataFetch(
	_endpoint: string,
	_params: Record<string, string>,
	_label: string,
	_logContext?: Record<string, unknown>,
	_policy?: MarketDataFetchPolicy,
): Promise<unknown> {
	return null;
}
