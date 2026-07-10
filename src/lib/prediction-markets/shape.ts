import type {
	DiscoveredPredictionOutcome,
	PredictionMarketOutcome,
	PredictionMarketShape,
} from "./types";

/** Exclusive-field total must land near 100% to claim mutual exclusivity. */
const EXCLUSIVE_TOTAL_TOLERANCE = 8;

const STRIKE_PATTERNS: RegExp[] = [
	/\$\s*([\d,]+(?:\.\d+)?)\s*([kmb])?\b/i,
	/\b(?:above|below|over|under|at least|at most|>=|<=|>|<)\s*\$?\s*([\d,]+(?:\.\d+)?)\s*([kmb])?\b/i,
	/\b([\d,]+(?:\.\d+)?)\s*%/,
];

function parseMagnitude(raw: string, suffix: string | undefined): number | null {
	const n = Number(raw.replace(/,/g, ""));
	if (!Number.isFinite(n)) return null;
	const s = (suffix ?? "").toLowerCase();
	if (s === "k") return n * 1_000;
	if (s === "m") return n * 1_000_000;
	if (s === "b") return n * 1_000_000_000;
	return n;
}

/** Extract a numeric strike from an outcome/market label when present. */
export function extractStrikeValue(label: string): number | null {
	for (const pattern of STRIKE_PATTERNS) {
		const m = label.match(pattern);
		if (!m) continue;
		const value = parseMagnitude(m[1] ?? "", m[2]);
		if (value !== null) return value;
	}
	return null;
}

function sumProbabilities(
	outcomes: readonly { probabilityPercent: number | null }[],
): number | null {
	let sum = 0;
	for (const o of outcomes) {
		if (o.probabilityPercent == null || !Number.isFinite(o.probabilityPercent)) return null;
		sum += o.probabilityPercent;
	}
	return Math.round(sum * 10) / 10;
}

function looksLikeYesNoPair(outcomes: readonly DiscoveredPredictionOutcome[]): boolean {
	if (outcomes.length !== 2) return false;
	const labels = outcomes.map((o) => o.label.trim().toLowerCase());
	return labels.includes("yes") && labels.includes("no");
}

function looksLikeThresholdLadder(outcomes: readonly DiscoveredPredictionOutcome[]): boolean {
	if (outcomes.length < 3) return false;
	const withStrikes = outcomes.filter((o) => o.strikeValue != null);
	return withStrikes.length >= Math.ceil(outcomes.length * 0.75);
}

export type ShapeDetectionInput = {
	outcomes: readonly DiscoveredPredictionOutcome[];
	/** Venue hint: Polymarket negRisk / exclusive event grouping. */
	negRisk?: boolean | null;
	/** Explicit venue flag that outcomes are mutually exclusive. */
	exclusiveHint?: boolean | null;
};

/**
 * Classify an event's probability semantics.
 * Uncertain → independent (safe non-aggregating fallback).
 */
export function detectPredictionMarketShape(input: ShapeDetectionInput): {
	shape: PredictionMarketShape;
	validated: boolean;
} {
	const { outcomes } = input;
	if (outcomes.length === 0) {
		return { shape: "independent", validated: false };
	}

	if (outcomes.length === 1 || looksLikeYesNoPair(outcomes)) {
		return { shape: "binary", validated: true };
	}

	if (looksLikeThresholdLadder(outcomes)) {
		return { shape: "threshold", validated: true };
	}

	const total = sumProbabilities(outcomes);
	const exclusiveHint = input.negRisk === true || input.exclusiveHint === true;
	if (exclusiveHint && total !== null && Math.abs(total - 100) <= EXCLUSIVE_TOTAL_TOLERANCE) {
		return { shape: "exclusive", validated: true };
	}

	// Multi-outcome without exclusive validation → independent.
	return { shape: "independent", validated: false };
}

/** Ensure binary cards always expose Yes + No totaling ~100%. */
export function ensureBinaryOutcomes(
	outcomes: readonly DiscoveredPredictionOutcome[],
	fallbackContractId: string,
): DiscoveredPredictionOutcome[] {
	if (looksLikeYesNoPair(outcomes)) {
		return [...outcomes].sort((a, b) => {
			const rank = (l: string) => (l.toLowerCase() === "yes" ? 0 : 1);
			return rank(a.label) - rank(b.label);
		});
	}
	if (outcomes.length === 1) {
		const yes = outcomes[0];
		if (!yes) return [];
		const yesPct = yes.probabilityPercent;
		const noPct =
			yesPct != null && Number.isFinite(yesPct) ? Math.round((100 - yesPct) * 10) / 10 : null;
		return [
			{ ...yes, label: "Yes", sortOrder: 0 },
			{
				venueContractId: `${fallbackContractId}:no`,
				label: "No",
				probabilityPercent: noPct,
				sortOrder: 1,
				strikeValue: null,
				volume: yes.volume,
			},
		];
	}
	return [...outcomes];
}

type CompressedOutcomeRow =
	| {
			kind: "outcome";
			label: string;
			probabilityPercent: number;
			highlighted: boolean;
	  }
	| {
			kind: "others";
			omittedCount: number;
			probabilityPercent: number;
	  }
	| {
			kind: "more";
			omittedCount: number;
	  };

export type CompressedEventBody = {
	rows: CompressedOutcomeRow[];
	/** Exclusive/independent footer note; threshold midpoint hint. */
	footnote: string | null;
	linkLabel: string;
};

function highlightMatch(label: string, highlightAlias: string | null): boolean {
	if (!highlightAlias) return false;
	return label.toLowerCase().includes(highlightAlias.toLowerCase());
}

/**
 * Apply shape-specific compression for display.
 * Never aggregates omitted mass for independent/threshold shapes.
 */
export function compressEventOutcomes(options: {
	shape: PredictionMarketShape;
	shapeValidated: boolean;
	outcomes: readonly PredictionMarketOutcome[];
	highlightAlias: string | null;
}): CompressedEventBody {
	const { shape, shapeValidated, outcomes, highlightAlias } = options;
	const valid = outcomes.filter(
		(o) => Number.isFinite(o.probabilityPercent) && o.probabilityPercent >= 0,
	);

	if (shape === "binary") {
		const rows: CompressedOutcomeRow[] = valid.map((o) => ({
			kind: "outcome" as const,
			label: o.label,
			probabilityPercent: o.probabilityPercent,
			highlighted: false,
		}));
		return { rows, footnote: null, linkLabel: "View full market" };
	}

	if (shape === "threshold") {
		const ordered = [...valid].sort((a, b) => {
			const as = a.strikeValue ?? a.sortOrder;
			const bs = b.strikeValue ?? b.sortOrder;
			return as - bs;
		});
		const crossoverIdx = ordered.findIndex((o) => o.probabilityPercent < 50);
		const center = crossoverIdx === -1 ? ordered.length - 1 : Math.max(0, crossoverIdx - 1);
		const start = Math.max(0, Math.min(center - 1, ordered.length - 4));
		const window = ordered.slice(start, start + 4);
		const rows: CompressedOutcomeRow[] = window.map((o) => ({
			kind: "outcome" as const,
			label: o.label,
			probabilityPercent: o.probabilityPercent,
			highlighted: highlightMatch(o.label, highlightAlias) || Boolean(o.highlighted),
		}));

		const above = ordered.filter((o) => o.probabilityPercent >= 50).at(-1);
		const below = ordered.find((o) => o.probabilityPercent < 50);
		let footnote: string | null = null;
		if (above && below && above.strikeValue != null && below.strikeValue != null) {
			footnote = `Implied midpoint between ${formatStrike(above.strikeValue)} and ${formatStrike(below.strikeValue)}`;
		} else if (above?.strikeValue != null) {
			footnote = `Implied above ${formatStrike(above.strikeValue)}`;
		}

		const linkLabel =
			ordered.length > window.length ? `View all ${ordered.length} strikes` : "View full market";
		return { rows, footnote, linkLabel };
	}

	// Exclusive / independent (and unvalidated exclusive → treat as independent)
	const effectiveShape = shape === "exclusive" && shapeValidated ? "exclusive" : "independent";

	const ranked = [...valid].sort((a, b) => b.probabilityPercent - a.probabilityPercent);
	const forceInclude = ranked.filter(
		(o) => highlightMatch(o.label, highlightAlias) || Boolean(o.highlighted),
	);

	if (effectiveShape === "exclusive" && ranked.length <= 6) {
		return {
			rows: ranked.map((o) => ({
				kind: "outcome" as const,
				label: o.label,
				probabilityPercent: o.probabilityPercent,
				highlighted: highlightMatch(o.label, highlightAlias) || Boolean(o.highlighted),
			})),
			footnote: null,
			linkLabel: "View full market",
		};
	}

	const picked: PredictionMarketOutcome[] = [];
	const seen = new Set<string>();
	for (const o of ranked) {
		if (picked.length >= 4) break;
		picked.push(o);
		seen.add(o.venueContractId);
	}
	for (const o of forceInclude) {
		if (seen.has(o.venueContractId)) continue;
		picked.push(o);
		seen.add(o.venueContractId);
	}

	const omitted = ranked.filter((o) => !seen.has(o.venueContractId));
	const rows: CompressedOutcomeRow[] = picked.map((o) => ({
		kind: "outcome" as const,
		label: o.label,
		probabilityPercent: o.probabilityPercent,
		highlighted: highlightMatch(o.label, highlightAlias) || Boolean(o.highlighted),
	}));

	if (effectiveShape === "exclusive" && omitted.length > 0) {
		const othersPct = Math.round(omitted.reduce((s, o) => s + o.probabilityPercent, 0) * 10) / 10;
		rows.push({
			kind: "others",
			omittedCount: omitted.length,
			probabilityPercent: othersPct,
		});
		return { rows, footnote: null, linkLabel: "View full market" };
	}

	if (omitted.length > 0) {
		rows.push({ kind: "more", omittedCount: omitted.length });
		return {
			rows,
			footnote: "Percentages do not sum to 100% — each option can resolve Yes.",
			linkLabel: "View full market",
		};
	}

	return {
		rows,
		footnote:
			effectiveShape === "independent"
				? "Percentages do not sum to 100% — each option can resolve Yes."
				: null,
		linkLabel: "View full market",
	};
}

function formatStrike(value: number): string {
	if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
	if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
	if (value > 0 && value < 1) return `${(value * 100).toFixed(0)}%`;
	return `$${value.toLocaleString("en-US")}`;
}
