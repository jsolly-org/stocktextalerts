import { rootLogger } from "../logging";

type ChatCompletionRequest = {
	model: string;
	messages: Array<{ role: "system" | "user"; content: string }>;
	temperature?: number;
	max_tokens?: number;
};

type ChatCompletionResponse = {
	choices?: Array<{
		message?: { content?: string | null };
	}>;
};

function buildRumorsPrompt(options: {
	tickers: string[];
	localDateIso: string;
	timezone: string;
}): { system: string; user: string } {
	const tickers = options.tickers.join(", ");
	return {
		system:
			"You write concise SMS add-ons for stock alerts. " +
			"Be descriptive, neutral, and cautious. " +
			"Do not give buy/sell advice. " +
			"Do not claim to have real-time data or verified facts. " +
			"Use hedge words like 'chatter' and 'unconfirmed' when appropriate.",
		user:
			`Write a short rumors/chatter summary for these tickers: ${tickers}.\n` +
			`Context: this will be sent in a scheduled SMS about the user's tracked stocks.\n` +
			`Local date: ${options.localDateIso} (${options.timezone}).\n\n` +
			"Output rules:\n" +
			"- 3–6 bullet points max\n" +
			"- each bullet starts with the ticker (e.g. 'AAPL: ...')\n" +
			"- keep total output under 500 characters\n" +
			"- no links\n" +
			"- end with: 'Unverified chatter — double-check before acting.'",
	};
}

export async function generateRumorsWithGrok(options: {
	tickers: string[];
	localDateIso: string;
	timezone: string;
	requestId?: string;
}): Promise<string | null> {
	if (options.tickers.length === 0) {
		return null;
	}

	const metaEnv = (import.meta as { env?: Record<string, string | undefined> })
		.env;
	const apiKey = metaEnv?.XAI_API_KEY ?? process.env.XAI_API_KEY;
	if (!apiKey || apiKey.trim() === "") {
		rootLogger.info("Skipping Grok rumors: XAI_API_KEY is not set", {
			action: "grok_rumors",
			reason: "missing_api_key",
			tickersCount: options.tickers.length,
			requestId: options.requestId,
		});
		return null;
	}
	const model =
		metaEnv?.XAI_GROK_MODEL ?? process.env.XAI_GROK_MODEL ?? "grok-4";
	const { system, user } = buildRumorsPrompt(options);

	const requestBody: ChatCompletionRequest = {
		model,
		messages: [
			{ role: "system", content: system },
			{ role: "user", content: user },
		],
		temperature: 0.4,
		max_tokens: 220,
	};

	try {
		const response = await fetch("https://api.x.ai/v1/chat/completions", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(requestBody),
			signal: AbortSignal.timeout(10_000),
		});

		if (!response.ok) {
			rootLogger.error("Grok rumors request failed", {
				action: "grok_rumors",
				status: response.status,
				statusText: response.statusText,
				model,
				tickersCount: options.tickers.length,
				requestId: options.requestId,
			});
			return null;
		}

		const data = (await response.json()) as ChatCompletionResponse;
		const text = data.choices?.[0]?.message?.content?.trim();
		if (!text) {
			rootLogger.error("Grok rumors returned empty content", {
				action: "grok_rumors",
				model,
				tickersCount: options.tickers.length,
				requestId: options.requestId,
			});
			return null;
		}

		return text;
	} catch (error) {
		const reason =
			error instanceof Error && error.name === "TimeoutError"
				? "timeout"
				: "request_failed";
		rootLogger.error(
			"Grok rumors request errored",
			{
				action: "grok_rumors",
				reason,
				model,
				tickersCount: options.tickers.length,
				requestId: options.requestId,
			},
			error,
		);
		return null;
	}
}
