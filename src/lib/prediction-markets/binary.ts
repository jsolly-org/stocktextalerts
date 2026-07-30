import type { PredictionMarketEventCard } from "./types";

const BINARY_LABEL_PAIRS: ReadonlySet<string> = new Set(["no|yes", "down|up"]);

/**
 * Curated macro (and preferred daily direction) cards are binary pairs:
 * Yes/No or Up/Down, two legs, finite percents totaling ~100.
 */
export function isStructuredBinaryCard(card: PredictionMarketEventCard): boolean {
	if (card.shape !== "binary" || card.shapeValidated !== true) return false;
	if (card.outcomes.length !== 2) return false;

	const labels = card.outcomes
		.map((o) => o.label.trim().toLowerCase())
		.sort()
		.join("|");
	if (!BINARY_LABEL_PAIRS.has(labels)) return false;

	let sum = 0;
	for (const outcome of card.outcomes) {
		const pct = outcome.probabilityPercent;
		if (!Number.isFinite(pct) || pct < 0 || pct > 100) return false;
		sum += pct;
	}
	return Math.abs(sum - 100) <= 1.5;
}

/** Throw with a concrete detail when a card fails the binary contract. */
export function assertStructuredBinaryCard(card: PredictionMarketEventCard): void {
	if (isStructuredBinaryCard(card)) return;
	const labels = card.outcomes.map((o) => `${o.label}=${o.probabilityPercent}`).join(", ");
	throw new Error(
		`prediction market ${card.key} is not a structured Yes/No or Up/Down binary (shape=${card.shape}, validated=${card.shapeValidated}, outcomes=[${labels}])`,
	);
}
