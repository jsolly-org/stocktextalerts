import type { BackupManifest } from "./types";

export function buildManifest(input: {
	takenAt: string;
	schemaVersion: string;
	rowCounts: Record<string, number>;
	columns: Record<string, string[]>;
}): BackupManifest {
	return {
		format: "pg-copy-text-v2",
		taken_at: input.takenAt,
		schema_version: input.schemaVersion,
		row_counts: input.rowCounts,
		columns: input.columns,
	};
}
