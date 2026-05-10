import { coerceValue } from "./coerce";
import type { FormIssue, FormSchema } from "./schema";

export function processFields(
	keys: readonly string[],
	rawData: Record<string, string | null>,
	schema: FormSchema,
): { errors: FormIssue[]; output: Record<string, unknown> } {
	const errors: FormIssue[] = [];
	const output: Record<string, unknown> = {};

	for (const key of keys) {
		const spec = schema[key];
		if (!spec) {
			throw new Error(`processFields invariant failed: missing schema spec for key "${key}"`);
		}
		const raw = rawData[key];

		if (raw == null) {
			if (spec.type === "boolean") {
				// HTML checkboxes submit no value when unchecked, which we treat as `false`
				// for optional boolean fields. Required booleans still enforce presence.
				if (spec.required) {
					errors.push({ reason: "missing_field", key });
				} else {
					output[key] = false;
				}
			} else if (spec.required) {
				errors.push({ reason: "missing_field", key });
			} else {
				output[key] = undefined;
			}
			continue;
		}

		const { value, error } = coerceValue(spec, raw);
		if (error) {
			errors.push({ ...error, key });
			continue;
		}

		if (value === undefined && spec.required) {
			errors.push({ reason: "missing_field", key });
			continue;
		}

		output[key] = value;
	}

	return { errors, output };
}
