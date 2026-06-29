/** No-op Finnhub vendor module for MODE=test Astro servers (E2E / HTTP tests). */

export type FinnhubFetchPolicy = {
	optional?: boolean;
};

export async function finnhubFetch(
	_endpoint: string,
	_params: Record<string, string>,
	_label: string,
	_policy?: FinnhubFetchPolicy,
): Promise<unknown> {
	return null;
}
