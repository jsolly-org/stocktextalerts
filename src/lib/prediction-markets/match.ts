import { outcomeMatchesIdentity, textHasIdentity } from "./aliases";
import type { AssetIdentity, IdentityEvidence, PredictionMatchKind } from "./types";

export type { IdentityEvidence };

const JUNK_RE =
	/\b(vs\.?|match|governor|election|temperature|tennis|atp|itf|mlb|nba|nhl|nfl|pga|mls|rookie of the year|espy|oscar|gpu rental|bahrain|bahia|dellavedova|dellien|spurs|hamad bin isa)\b/i;

const EARNINGS_MENTION_RE =
	/\b(what will .{0,40} say|earnings mention|said during .{0,20}earnings|said on the (next )?call)\b/i;

/** Stock-price lexicon for title-identity markets (e.g. "What will TSLA hit?"). */
const PRICE_RE =
	/\b(hit|close above|closes?(?:\s+\w+){0,4}\s+(?:above|at|below)|finish\b.{0,30}\babove|up or down|will .+ close|price will)\b/i;

/**
 * Stronger price signals for outcome-leg markets. Bare "hit" is too noisy there
 * ("first hit 1550 on Chatbot Arena") and must not upgrade a competitive race
 * to direct_price.
 */
const STRONG_PRICE_RE =
	/\b(close above|closes?(?:\s+\w+){0,4}\s+(?:above|at|below)|finish\b.{0,30}\babove|up or down|will .+ close|price will|share price|stock price)\b/i;

const KPI_RE =
	/\b(production|customers?|headcount|employees?|deliveries|restaurant|funded customers|revenue|eps|report above|capex|capital expenditures)\b/i;

/**
 * Classify relation from market/event title. Returns null for junk / chatter / unknown.
 */
function classifyMatchKind(title: string): PredictionMatchKind | null {
	if (JUNK_RE.test(title)) return null;
	if (EARNINGS_MENTION_RE.test(title)) return null;
	if (PRICE_RE.test(title)) return "direct_price";
	if (KPI_RE.test(title)) return "kpi";
	// Company-subject catch-all for named events (product, M&A, competitive races, …)
	if (
		/\b(acqui|merger|bankrupt|lawsuit|fda|approv|ceo|robotaxi|optimus|ipo|split|dividend|foldable|gigafactory|starship|launch|arena|which company|first to)\b/i.test(
			title,
		)
	) {
		return "company_subject";
	}
	// If identity is in the title but no stronger class, still company_subject.
	return "company_subject";
}

export function isJunkTitle(title: string): boolean {
	return JUNK_RE.test(title) || EARNINGS_MENTION_RE.test(title);
}

/**
 * Gate: company must be first-class subject via title identity or outcome leg.
 */
export function findIdentityEvidence(
	title: string,
	outcomeLabels: readonly string[],
	identity: AssetIdentity,
): IdentityEvidence | null {
	if (isJunkTitle(title)) return null;

	const titleHit = textHasIdentity(title, identity);
	if (titleHit.hit && titleHit.alias) {
		return { where: "title", alias: titleHit.alias };
	}

	for (const outcome of outcomeLabels) {
		const o = outcomeMatchesIdentity(outcome, identity);
		if (o.hit && o.alias) {
			return { where: "outcome", alias: o.alias };
		}
	}

	return null;
}

/** Resolve match kind given title + whether evidence came from an outcome leg. */
export function resolveMatchKind(
	title: string,
	evidence: IdentityEvidence,
): PredictionMatchKind | null {
	if (isJunkTitle(title)) return null;
	if (evidence.where === "outcome") {
		// Outcome-leg markets are company_subject (competitive races, etc.)
		// unless the nested question itself is clearly price/KPI — use the
		// strong price lexicon so Arena "hit" scores stay company_subject.
		if (STRONG_PRICE_RE.test(title)) return "direct_price";
		if (KPI_RE.test(title)) return "kpi";
		return "company_subject";
	}
	const kind = classifyMatchKind(title);
	if (kind === null) return null;
	// Title-only with no price/kpi lexicon still counts as company_subject
	// when identity was found — classifyMatchKind already returns that.
	return kind;
}
