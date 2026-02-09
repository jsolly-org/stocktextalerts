import { rootLogger } from "./logging";

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

type SmsExtrasResult = {
	news: string | null;
	rumors: string | null;
};

function getMetaEnv(): Record<string, string | undefined> | undefined {
	return (import.meta as { env?: Record<string, string | undefined> }).env;
}

function buildExtrasPrompt(options: {
	tickers: string[];
	localDateIso: string;
	timezone: string;
	includeNews: boolean;
	includeRumors: boolean;
}): { system: string; user: string } {
	const tickers = options.tickers.join(", ");
	const requested = [
		options.includeNews ? "news" : null,
		options.includeRumors ? "rumors" : null,
	]
		.filter(Boolean)
		.join(" + ");

	return {
		system:
			"You write concise SMS add-ons for stock alerts. " +
			"Be descriptive, neutral, and cautious. " +
			"Do not give buy/sell advice. " +
			"Do not claim to have real-time data or verified facts. " +
			"Do not mention any specific websites, publications, or sources.",
		user:
			`Write short ${requested || "extras"} content for these tickers: ${tickers}.\n` +
			`Context: this will be sent as a daily add-on notification.\n` +
			`Local date: ${options.localDateIso} (${options.timezone}).\n\n` +
			"Return EXACTLY this tagged format (no extra text outside tags):\n" +
			"[NEWS]\n" +
			"<content>\n" +
			"[/NEWS]\n" +
			"[RUMORS]\n" +
			"<content>\n" +
			"[/RUMORS]\n\n" +
			"Rules:\n" +
			"- If news is not requested, output nothing between [NEWS] and [/NEWS].\n" +
			"- If rumors are not requested, output nothing between [RUMORS] and [/RUMORS].\n" +
			"- Each requested section: 2–5 bullet points max.\n" +
			"- Each bullet starts with the ticker (e.g. 'AAPL: ...').\n" +
			"- No links.\n" +
			"- Keep each section under 450 characters.\n" +
			"- News: focus on broad business/company developments people commonly discuss.\n" +
			"- Rumors: use hedge words like 'chatter' and 'unconfirmed'. End the section with: 'Unverified chatter — double-check before acting.'",
	};
}

function extractTaggedBlock(
	text: string,
	tag: "NEWS" | "RUMORS",
): string | null {
	const start = `[${tag}]`;
	const end = `[/${tag}]`;
	const startIndex = text.indexOf(start);
	const endIndex = text.indexOf(end);
	if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
		return null;
	}

	const content = text.slice(startIndex + start.length, endIndex).trim();
	return content === "" ? null : content;
}

export async function generateAddOnsExtrasWithGrok(options: {
	tickers: string[];
	localDateIso: string;
	timezone: string;
	includeNews: boolean;
	includeRumors: boolean;
	requestId?: string;
}): Promise<SmsExtrasResult | null> {
	if (options.tickers.length === 0) {
		return null;
	}
	if (!options.includeNews && !options.includeRumors) {
		return null;
	}

	const metaEnv = getMetaEnv();
	const apiKey = metaEnv?.XAI_API_KEY ?? process.env.XAI_API_KEY;
	if (!apiKey || apiKey.trim() === "") {
		rootLogger.info("Skipping Grok extras: XAI_API_KEY is not set", {
			action: "grok_extras",
			reason: "missing_api_key",
			tickersCount: options.tickers.length,
			includeNews: options.includeNews,
			includeRumors: options.includeRumors,
			requestId: options.requestId,
		});
		return null;
	}

	const model =
		metaEnv?.XAI_GROK_MODEL ?? process.env.XAI_GROK_MODEL ?? "grok-4";
	const { system, user } = buildExtrasPrompt(options);

	const requestBody: ChatCompletionRequest = {
		model,
		messages: [
			{ role: "system", content: system },
			{ role: "user", content: user },
		],
		temperature: 0.4,
		max_tokens: 300,
	};

	const MAX_RETRIES = 3;
	const RETRY_DELAY_MS = 2_000;
	const logContext = {
		action: "grok_extras",
		model,
		tickersCount: options.tickers.length,
		includeNews: options.includeNews,
		includeRumors: options.includeRumors,
		requestId: options.requestId,
	};

	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		const isLastAttempt = attempt === MAX_RETRIES;
		const log = isLastAttempt
			? rootLogger.error.bind(rootLogger)
			: rootLogger.warn.bind(rootLogger);

		try {
			const response = await fetch("https://api.x.ai/v1/chat/completions", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(requestBody),
				signal: AbortSignal.timeout(15_000),
			});

			if (!response.ok) {
				log("Grok extras request failed", {
					...logContext,
					attempt,
					status: response.status,
					statusText: response.statusText,
				});
				if (!isLastAttempt) {
					await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
					continue;
				}
				return null;
			}

			const data = (await response.json()) as ChatCompletionResponse;
			const text = data.choices?.[0]?.message?.content?.trim();
			if (!text) {
				log("Grok extras returned empty content", {
					...logContext,
					attempt,
				});
				if (!isLastAttempt) {
					await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
					continue;
				}
				return null;
			}

			const news = options.includeNews
				? extractTaggedBlock(text, "NEWS")
				: null;
			const rumors = options.includeRumors
				? extractTaggedBlock(text, "RUMORS")
				: null;

			if (!news && !rumors) {
				log("Grok extras missing expected tags/content", {
					...logContext,
					attempt,
				});
				if (!isLastAttempt) {
					await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
					continue;
				}
				return null;
			}

			return { news, rumors };
		} catch (error) {
			const reason =
				error instanceof Error && error.name === "TimeoutError"
					? "timeout"
					: "request_failed";
			log(
				"Grok extras request errored",
				{ ...logContext, attempt, reason },
				error,
			);
			if (!isLastAttempt) {
				await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
				continue;
			}
			return null;
		}
	}

	return null;
}
