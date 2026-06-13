import { gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";

const send = vi.fn().mockResolvedValue({});
vi.mock("@aws-sdk/client-s3", () => ({
	S3Client: vi.fn(() => ({ send })),
	PutObjectCommand: vi.fn((input) => ({ __type: "put", input })),
}));

import { packBackup } from "../../../src/lib/backup/storage";

describe("packBackup", () => {
	it("gzips a JSON envelope of manifest + tables", () => {
		const buf = packBackup({
			manifest: {
				format: "pg-copy-text-v1",
				taken_at: "2026-06-13T12:00:00.000Z",
				schema_version: "v1",
				row_counts: { "public.users": 1 },
			},
			tables: { "public.users": "1\tjohn@x.com\n" },
		});
		const parsed = JSON.parse(gunzipSync(buf).toString("utf8"));
		expect(parsed.manifest.schema_version).toBe("v1");
		expect(parsed.tables["public.users"]).toBe("1\tjohn@x.com\n");
	});
});
