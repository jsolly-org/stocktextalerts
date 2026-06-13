export type BackupManifest = {
	format: "pg-copy-text-v2";
	taken_at: string;
	schema_version: string;
	row_counts: Record<string, number>;
	/** Explicit COPY column list per table (excludes generated columns). Restore
	 * replays with the same list so data aligns by name, not physical position. */
	columns: Record<string, string[]>;
};

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
