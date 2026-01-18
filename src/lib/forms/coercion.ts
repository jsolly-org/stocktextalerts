import type {
	FieldSpec,
	FormIssue,
	FormSchema,
	InferSchema,
	ParseOutcome,
} from "./schema";

type RawSchemaData = {
	keys: readonly string[];
	rawData: Record<string, string | null>;
	validationErrors: FormIssue[];
};

const DEFAULT_TRUTHY_VALUES = ["on", "true", "1"];
const DEFAULT_FALSY_VALUES = ["off", "false", "0"];
const TIME_PATTERN = /^([0-1]?[0-9]|2[0-3]):([0-5][0-9])$/;
const FLOAT_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

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

		if (seen.has(key)) {
			console.error("readRawSchemaData rejected duplicate key", { key });
			validationErrors.push({
				reason: "duplicate_key",
				key,
			});
			continue;
		}

		if (typeof value !== "string") {
			const valueType = typeof value;
			console.error("readRawSchemaData rejected non-string value", {
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

export function coerceValue(
	spec: FieldSpec,
	raw: string,
): { value: unknown; error?: FormIssue } {
	switch (spec.type) {
		case "boolean": {
			const truthyValues = spec.truthyValues ?? DEFAULT_TRUTHY_VALUES;
			const falsyValues = spec.falsyValues ?? DEFAULT_FALSY_VALUES;

			if (raw === "") {
				return { value: undefined };
			}

			if (truthyValues.includes(raw)) {
				return { value: true };
			}

			if (falsyValues.includes(raw)) {
				return { value: false };
			}

			return {
				value: undefined,
				error: { reason: "invalid_boolean", key: "", value: raw },
			};
		}
		case "string": {
			// Trimming is only used for untrusted external input (e.g., webhooks like Twilio SMS).
			// Normal app forms should not set trim: true and should validate input strictly.
			const value = spec.trim === true ? raw.trim() : raw;
			if (value === "") {
				return { value: undefined };
			}
			return { value };
		}
		case "time": {
			if (raw === "") {
				return { value: undefined };
			}

			if (!TIME_PATTERN.test(raw)) {
				return {
					value: undefined,
					error: { reason: "invalid_time", key: "", value: raw },
				};
			}

			const [hoursStr, minutesStr] = raw.split(":");
			const hours = Number.parseInt(hoursStr, 10);
			const minutes = Number.parseInt(minutesStr, 10);
			const totalMinutes = hours * 60 + minutes;

			return { value: totalMinutes };
		}
		case "enum": {
			if (raw === "") {
				return { value: undefined };
			}
			if (!spec.values.includes(raw)) {
				return {
					value: undefined,
					error: { reason: "invalid_enum", key: "", values: spec.values },
				};
			}
			return { value: raw };
		}
		case "timezone": {
			if (raw === "") {
				return { value: undefined };
			}
			// Trim timezone values from form submissions (untrusted external input) to ensure
			// consistency with database constraint (users_timezone_no_whitespace CHECK).
			// This prevents validation failures when the value reaches the database.
			const trimmed = raw.trim();
			if (trimmed === "") {
				return { value: undefined };
			}
			return { value: trimmed };
		}
		case "integer": {
			if (raw === "") {
				return { value: undefined };
			}

			if (!/^-?\d+$/.test(raw)) {
				return {
					value: undefined,
					error: { reason: "invalid_integer", key: "", value: raw },
				};
			}

			return { value: Number.parseInt(raw, 10) };
		}
		case "number": {
			if (raw === "") {
				return { value: undefined };
			}

			if (!FLOAT_PATTERN.test(raw)) {
				return {
					value: undefined,
					error: { reason: "invalid_number", key: "", value: raw },
				};
			}

			const parsedValue = Number.parseFloat(raw);
			return { value: parsedValue };
		}
		case "json_string_array": {
			if (raw === "") {
				return { value: undefined };
			}

			try {
				const parsedValue = JSON.parse(raw);

				if (!Array.isArray(parsedValue)) {
					return {
						value: undefined,
						error: { reason: "invalid_json_array", key: "", value: raw },
					};
				}

				if (!parsedValue.every((entry) => typeof entry === "string")) {
					return {
						value: undefined,
						error: {
							reason: "invalid_json_array_elements",
							key: "",
							value: raw,
						},
					};
				}

				return { value: parsedValue };
			} catch {
				return {
					value: undefined,
					error: { reason: "invalid_json_array", key: "", value: raw },
				};
			}
		}
		default: {
			console.error("Unexpected field type:", spec);
			return { value: raw };
		}
	}
}

export function processFields(
	keys: readonly string[],
	rawData: Record<string, string | null>,
	schema: FormSchema,
): { errors: FormIssue[]; output: Record<string, unknown> } {
	const errors: FormIssue[] = [];
	const output: Record<string, unknown> = {};

	for (const key of keys) {
		const spec = schema[key] as FieldSpec;
		const raw = rawData[key];

		if (raw === null) {
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

export function coerceWithSchema<TSchema extends FormSchema>(
	formData: FormData,
	schema: TSchema,
): ParseOutcome<InferSchema<TSchema>>;
export function coerceWithSchema<TSchema extends FormSchema, TResult>(
	formData: FormData,
	schema: TSchema,
	transform: (data: InferSchema<TSchema>) => TResult,
): ParseOutcome<TResult>;
export function coerceWithSchema<TSchema extends FormSchema, TResult>(
	formData: FormData,
	schema: TSchema,
	transform?: (data: InferSchema<TSchema>) => TResult,
): ParseOutcome<InferSchema<TSchema> | TResult> {
	const { keys, rawData, validationErrors } = readRawSchemaData(
		formData,
		schema,
	);

	if (validationErrors.length > 0) {
		return {
			ok: false,
			error: validationErrors[0],
			allErrors: validationErrors,
		};
	}

	const { errors, output } = processFields(keys, rawData, schema);

	if (errors.length > 0) {
		return {
			ok: false,
			error: errors[0],
			allErrors: errors,
		};
	}

	const baseResult = output as InferSchema<TSchema>;
	const transformed = transform ? transform(baseResult) : baseResult;

	return {
		ok: true,
		data: transformed,
	};
}
