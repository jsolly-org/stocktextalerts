export type GrokResponsesRequest = {
	model: string;
	input: string;
	instructions: string;
	temperature?: number;
	max_output_tokens?: number;
	tools?: Array<{ type: "web_search" | "x_search" }>;
	include?: string[];
};

export type GrokResponsesResponse = {
	id: string;
	object: "response" | (string & {});
	created_at: number;
	model: string;
	status: string;
	output: Array<{
		id?: string;
		type?: string;
		role?: string;
		status?: string;
		content?: Array<{
			type?: string;
			text?: string;
			annotations?: unknown;
		}>;
		summary?: Array<{ type?: string; text?: string }>;
		[key: string]: unknown;
	}>;
};

// xAI Responses API (OpenAPI `ModelResponse`)
export type XaiAnnotation = {
	type: string;
	url: string;
	title?: string;
	start_index?: number | null;
	end_index?: number | null;
};

export type FinnhubFetchPolicy = {
	/** When true, terminal failures log as optional degradation (warn), not vendor_retry_exhausted. */
	optional?: boolean;
};

export type CircuitState = {
	failures: number;
	openUntilMs: number;
};
