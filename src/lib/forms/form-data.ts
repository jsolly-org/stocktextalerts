import { rootLogger } from "../logging";
import type { FormIssue, FormSchema } from "./schema";

type RawSchemaData = {
	keys: readonly string[];
	rawData: Record<string, string | null>;
	validationErrors: FormIssue[];
};

/**
 * Extract and validate raw `FormData` entries against a schema.
 *
 * Returns a fixed key set, a raw data map (missing keys are `null`), and structured validation
 * errors for unsupported shapes (duplicate keys, non-string values, etc).
 */
export function readRawSchemaData(
	formData: FormData,
	schema: FormSchema,
): RawSchemaData {
	const keys = Object.keys(schema) as readonly string[];
	const schemaKeySet = new Set(keys);
	const rawData: Record<string, string | null> = {};
	const seen = new Set<string>();
	const validationErrors: FormIssue[] = [];

	for (const key of keys) {
		rawData[key] = null;
	}

	for (const [key, value] of formData.entries()) {
		if (!schemaKeySet.has(key)) {
			continue;
		}

		const spec = schema[key];
		if (seen.has(key)) {
			if (spec?.type === "boolean" && typeof value === "string") {
				rawData[key] = value;
				continue;
			}
			rootLogger.error("readRawSchemaData rejected duplicate key", { key });
			validationErrors.push({
				reason: "duplicate_key",
				key,
			});
			continue;
		}

		if (typeof value !== "string") {
			const valueType = typeof value;
			rootLogger.error("readRawSchemaData rejected non-string value", {
				key,
				valueType,
			});
			validationErrors.push({
				reason: "non_string_value",
				key,
				valueType,
			});
			continue;
		}

		rawData[key] = value;
		seen.add(key);
	}

	return {
		keys,
		rawData,
		validationErrors,
	};
}
