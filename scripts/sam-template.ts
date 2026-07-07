/**
 * scripts/sam-template.ts — the ONE line/regex walker over aws/template.yaml that
 * every guard script shares (check-deploy-functions, check-infra-drift). Regex, not
 * a YAML parse, on purpose: the SAM template is full of CloudFormation intrinsic
 * tags (!Ref/!Sub/!GetAtt) that plain YAML loaders choke on, and the guards only
 * need literal scalars. Keeping a single walker means the two guards provably agree
 * on what counts as "a function" — a convention change (indent, FunctionName
 * prefix) lands once, not in drifting copies.
 *
 * Walk rules: inside `Globals: → Function:` capture the default Timeout/MemorySize;
 * inside each top-level resource block (logical ID at 2-space indent) capture Type,
 * literal `FunctionName: stocktextalerts-*`, and literal Timeout/MemorySize.
 * Property regexes require ≥6-space indent so a resource-level key can never be
 * misread, and only the first match per block wins (nested mappings like
 * DeadLetterQueue can't override). A function without a literal FunctionName is
 * still captured (with `functionName: null`) so callers can fail loud on it rather
 * than silently drop it.
 */

export type SamTemplateFunction = {
	logicalId: string;
	functionName: string | null;
	timeout: number | null;
	memorySize: number | null;
};

export type SamGlobalsDefaults = { timeout: number | null; memorySize: number | null };

export function parseSamTemplate(text: string): {
	globals: SamGlobalsDefaults;
	functions: SamTemplateFunction[];
} {
	const RESOURCE_HEADER_RE = /^ {2}([A-Za-z][A-Za-z0-9]*):\s*(?:#.*)?$/;
	const TYPE_RE = /^ {4}Type:\s*(\S+)\s*$/;
	const FUNCTION_NAME_RE = /^ {6,}FunctionName:\s*(stocktextalerts-[a-z0-9-]+)\s*(?:#.*)?$/;
	const TIMEOUT_RE = /^ {6,}Timeout:\s*(\d+)\s*(?:#.*)?$/;
	const MEMORY_RE = /^ {6,}MemorySize:\s*(\d+)\s*(?:#.*)?$/;
	const GLOBALS_TIMEOUT_RE = /^ {4}Timeout:\s*(\d+)\s*(?:#.*)?$/;
	const GLOBALS_MEMORY_RE = /^ {4}MemorySize:\s*(\d+)\s*(?:#.*)?$/;

	const globals: SamGlobalsDefaults = { timeout: null, memorySize: null };
	const functions: SamTemplateFunction[] = [];

	let inGlobals = false;
	let logicalId: string | null = null;
	let isFunction = false;
	let functionName: string | null = null;
	let timeout: number | null = null;
	let memorySize: number | null = null;

	const flush = (): void => {
		// Capture EVERY Serverless::Function, even one without a literal
		// FunctionName — callers fail loud on those rather than letting them slip.
		if (logicalId && isFunction) {
			functions.push({ logicalId, functionName, timeout, memorySize });
		}
	};

	for (const line of text.split("\n")) {
		if (/^Globals:\s*$/.test(line)) {
			inGlobals = true;
			continue;
		}
		if (/^[A-Za-z]/.test(line)) {
			// Any new top-level section (Resources:, Outputs:, …) ends Globals.
			inGlobals = false;
		}
		if (inGlobals) {
			const gt = GLOBALS_TIMEOUT_RE.exec(line);
			if (gt?.[1]) globals.timeout = Number(gt[1]);
			const gm = GLOBALS_MEMORY_RE.exec(line);
			if (gm?.[1]) globals.memorySize = Number(gm[1]);
			continue;
		}

		const header = RESOURCE_HEADER_RE.exec(line);
		if (header) {
			// A new top-level resource block starts — close out the previous one.
			flush();
			logicalId = header[1] ?? null;
			isFunction = false;
			functionName = null;
			timeout = null;
			memorySize = null;
			continue;
		}
		if (!logicalId) continue;
		const typeMatch = TYPE_RE.exec(line);
		if (typeMatch && typeMatch[1] === "AWS::Serverless::Function") {
			isFunction = true;
			continue;
		}
		const nameMatch = FUNCTION_NAME_RE.exec(line);
		if (nameMatch?.[1] && functionName === null) functionName = nameMatch[1];
		const timeoutMatch = TIMEOUT_RE.exec(line);
		if (timeoutMatch?.[1] && timeout === null) timeout = Number(timeoutMatch[1]);
		const memoryMatch = MEMORY_RE.exec(line);
		if (memoryMatch?.[1] && memorySize === null) memorySize = Number(memoryMatch[1]);
	}
	flush();
	return { globals, functions };
}
