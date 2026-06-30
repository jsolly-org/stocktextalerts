import { SIC_RANGES } from "./constants";

export function sicCodeToSector(sicCode: string): string {
	const code = Number.parseInt(sicCode, 10);
	if (!Number.isFinite(code) || code < 0) return "Other";

	for (const range of SIC_RANGES) {
		if (code >= range.min && code <= range.max) {
			return range.sector;
		}
	}
	return "Other";
}
