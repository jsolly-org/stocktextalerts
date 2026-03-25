import * as esbuild from "esbuild";

const entryPoints = [
	"aws/src/handlers/schedule.ts",
	"aws/src/handlers/asset-events.ts",
	"aws/src/handlers/compute-daily-stats.ts",
];

await esbuild.build({
	entryPoints,
	bundle: true,
	platform: "node",
	target: "node24",
	format: "esm",
	outdir: "aws/dist/handlers",
	outExtension: { ".js": ".mjs" },
	sourcemap: true,
	// Some npm packages (e.g. twilio) use require() internally.
	// ESM bundles need createRequire to support this.
	banner: {
		js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
	},
	// Nothing is external — bundle everything for fast Lambda cold starts.
	external: [],
});

console.log("Lambda bundles built successfully.");
