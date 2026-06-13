export type BackupManifest = {
	format: "pg-copy-text-v1";
	taken_at: string;
	schema_version: string;
	row_counts: Record<string, number>;
};

export function buildManifest(input: {
	takenAt: string;
	schemaVersion: string;
	rowCounts: Record<string, number>;
}): BackupManifest {
	return {
		format: "pg-copy-text-v1",
		taken_at: input.takenAt,
		schema_version: input.schemaVersion,
		row_counts: input.rowCounts,
	};
}
