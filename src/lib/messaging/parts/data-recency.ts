/** User-facing disclosure for Massive's delayed snapshot data. */
const DATA_RECENCY_TEXT = "Prices delayed up to 15 minutes.";

export function buildDataRecencyText(): string {
	return DATA_RECENCY_TEXT;
}

export function buildDataRecencyHtml(): string {
	return `<div style="background: #eff6ff; border: 1px solid #93c5fd; border-radius: 8px; padding: 10px 14px; margin-bottom: 16px; text-align: center; color: #1e40af; font-size: 12px;">
			${DATA_RECENCY_TEXT}
		</div>`;
}
