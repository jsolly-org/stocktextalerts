#!/usr/bin/env tsx
// Restores src/lib/logging/release-id.ts to its committed stub after a build.
// Called by the postbuild npm hook and by aws/deploy-web.sh after sam build,
// so the tracked file stays clean and never lands committed with a real SHA.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

writeFileSync(
	resolve(import.meta.dirname, "../src/lib/logging/release-id.ts"),
	'// Stub — overwritten at build time by scripts/gen-release-id.ts. Do not commit the generated version.\nexport const RELEASE_ID = "dev";\n',
);
