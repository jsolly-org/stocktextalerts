/**
 * Canonical xAI model IDs for product Grok calls.
 *
 * Tiering (intelligence + cost):
 * - Digest / aliases: `grok-4.3` + `reasoning_effort: "none"` (same $/tok as
 *   dated 4.20 non-reasoning; newer IF/tools generation).
 * - Price-move why: `grok-4.3` + `low` (short blurb + search tools).
 */
export const GROK_DIGEST_MODEL = "grok-4.3";
export const GROK_WHY_MODEL = "grok-4.3";
export const GROK_ALIAS_MODEL = "grok-4.3";
