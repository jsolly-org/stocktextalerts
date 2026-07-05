/**
 * Lightweight import-layer guard for `src/lib`.
 * Fails when known layer inversions reappear after refactors.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const LIB_ROOT = join(process.cwd(), "src/lib");

type Rule = {
	fromPrefix: string;
	forbiddenImport: RegExp;
	message: string;
};

const RULES: Rule[] = [
	{
		fromPrefix: "market-data/",
		forbiddenImport: /market-notifications\//,
		message: "market-data must not import market-notifications",
	},
	{
		fromPrefix: "db/",
		forbiddenImport: /schedule\//,
		message: "db must not import schedule (use db/supabase and scheduled-notifications/*)",
	},
	{
		fromPrefix: "time/",
		forbiddenImport: /schedule\/helpers/,
		message: "time must not import schedule/helpers",
	},
];

function walkTsFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		const stat = statSync(path);
		if (stat.isDirectory()) {
			if (entry === "generated") continue;
			walkTsFiles(path, out);
		} else if (entry.endsWith(".ts")) {
			out.push(path);
		}
	}
	return out;
}

const violations: string[] = [];

for (const file of walkTsFiles(LIB_ROOT)) {
	const rel = relative(LIB_ROOT, file).replace(/\\/g, "/");
	const source = readFileSync(file, "utf8");
	for (const rule of RULES) {
		if (!rel.startsWith(rule.fromPrefix)) continue;
		if (rule.forbiddenImport.test(source)) {
			violations.push(`${rel}: ${rule.message}`);
		}
	}
}

if (violations.length > 0) {
	process.stderr.write("Import boundary violations:\n");
	for (const v of violations) {
		process.stderr.write(`  - ${v}\n`);
	}
	process.exit(1);
}

process.stdout.write("check:lib-boundaries OK\n");
