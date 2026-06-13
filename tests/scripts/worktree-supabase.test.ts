import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";

import { applyWorktreePorts } from "../../scripts/db/worktree-supabase";

// Mirrors the real supabase/config.toml shape: no [api] table, no explicit [db]/[studio] port
// (Supabase defaults), [db] carrying nested subtables, only [inbucket] with explicit ports.
const BASE = `project_id = "stocktextalerts"

[db]
major_version = 17

[db.migrations]
schema_paths = []

[db.seed]
sql_paths = ["./seed.sql"]

[studio]
enabled = true

[inbucket]
port = 54324
smtp_port = 1025
`;

const META = {
	projectId: "stocktextalerts-wt-feat",
	ports: { api: 54331, db: 54332, studio: 54333, inbucket: 54334, smtp: 1026 },
};

type ParsedConfig = {
	project_id: string;
	api: { port: number };
	db: { port: number; major_version: number; migrations: unknown; seed: { sql_paths: string[] } };
	studio: { port: number; enabled: boolean };
	inbucket: { port: number; smtp_port: number };
};

const parseConfig = (toml: string) => parse(toml) as unknown as ParsedConfig;

describe("applyWorktreePorts", () => {
	it("sets project_id and the five ports in their own tables", () => {
		const parsed = parseConfig(applyWorktreePorts(BASE, META));
		expect(parsed.project_id).toBe("stocktextalerts-wt-feat");
		expect(parsed.api.port).toBe(54331);
		expect(parsed.db.port).toBe(54332);
		expect(parsed.studio.port).toBe(54333);
		expect(parsed.inbucket.port).toBe(54334);
		expect(parsed.inbucket.smtp_port).toBe(1026);
	});

	it("produces valid TOML with no duplicate-table corruption and preserves [db] subtables", () => {
		const out = applyWorktreePorts(BASE, META);
		// Re-parse must not throw, and must be stable (no duplicate [db] tables, etc.).
		expect(parse(out)).toEqual(parse(out));
		const parsed = parseConfig(out);
		expect(parsed.db.major_version).toBe(17); // existing key kept
		expect(parsed.db.migrations).toBeTruthy(); // nested subtable preserved
		expect(parsed.db.seed.sql_paths).toEqual(["./seed.sql"]);
		expect(parsed.studio.enabled).toBe(true); // existing key kept
	});
});
