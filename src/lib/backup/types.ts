export type BackupManifest = {
	format: "pg-copy-text-v2";
	taken_at: string;
	schema_version: string;
	row_counts: Record<string, number>;
	/** Explicit COPY column list per table (excludes generated columns). Restore
	 * replays with the same list so data aligns by name, not physical position. */
	columns: Record<string, string[]>;
};

export type BackupPayload = { manifest: BackupManifest; tables: Record<string, string> };
