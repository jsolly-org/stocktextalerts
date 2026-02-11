import { rootLogger } from "../logging";

const GROK_TIMEOUT_MS = 10_000;

/**
 * Generate a 1-2 sentence AI summary for an instant alert using Grok.
 *
 * Shorter prompt and timeout than the daily digest. Returns null on failure.
 */
export async function generateInstantAlertSummary(options: {
	symbol: string;
	priceContext: string;
	signalContext: string;
	headlines: string[];
}): Promise<string | null> {
	const apiKey = process.env.XAI_API_KEY;
	if (!apiKey || apiKey.trim() === "") {
		return null;
	}

	const headlinesBlock =
		options.headlines.length > 0
			? `\nRecent headlines:\n${options.headlines.map((h) => `- ${h}`).join("\n")}`
			: "";

	const prompt =
		`${options.symbol}: ${options.priceContext}. ` +
		`Signals: ${options.signalContext}.${headlinesBlock}\n\n` +
		"Write 1-2 neutral, factual sentences summarizing why this stock is notable right now. " +
		"Do not give investment advice.";

	try {
		const response = await fetch("https://api.x.ai/v1/responses", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: "grok-4-1-fast",
				instructions:
					"You write brief, neutral market alert summaries. No buy/sell advice.",
				input: prompt,
				temperature: 0.3,
				max_tokens: 200,
			}),
			signal: AbortSignal.timeout(GROK_TIMEOUT_MS),
		});

		if (!response.ok) {
			rootLogger.warn("Grok instant alert summary failed", {
				status: response.status,
			});
			return null;
		}

		const data = (await response.json()) as {
			output?: Array<{
				type?: string;
				content?: Array<{ type?: string; text?: string }>;
			}>;
		};

		for (const item of data.output ?? []) {
			if (item.type !== "message") continue;
			for (const part of item.content ?? []) {
				if (
					(part.type === "output_text" || part.type === "text") &&
					typeof part.text === "string" &&
					part.text.trim() !== ""
				) {
					return part.text.trim();
				}
			}
		}

		return null;
	} catch (error) {
		const reason =
			error instanceof Error && error.name === "TimeoutError"
				? "timeout"
				: "request_failed";
		rootLogger.warn("Grok instant alert summary error", { reason }, error);
		return null;
	}
}
