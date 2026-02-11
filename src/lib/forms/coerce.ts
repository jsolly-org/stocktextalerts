import type { FieldSpec, FormIssue } from "./schema";

const DEFAULT_TRUTHY_VALUES = ["on", "true", "1"];
const DEFAULT_FALSY_VALUES = ["off", "false", "0"];
const TIME_PATTERN = /^([0-1]?[0-9]|2[0-3]):([0-5][0-9])$/;
const FLOAT_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * Coerce a raw string form value into the typed value defined by the field spec.
 *
 * Returns `{ value: undefined }` for empty optional fields and includes a structured `FormIssue`
 * when coercion fails.
 */
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
					error: {
						reason: "invalid_enum",
						key: "",
						value: raw,
						values: spec.values,
					},
				};
			}
			return { value: raw };
		}
		case "timezone": {
			if (raw === "") {
				return { value: undefined };
			}
			return { value: raw };
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

			const parsedValue = Number.parseInt(raw, 10);
			const rawBigInt = BigInt(raw);
			const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
			const minSafe = BigInt(Number.MIN_SAFE_INTEGER);
			if (rawBigInt > maxSafe || rawBigInt < minSafe) {
				return {
					value: undefined,
					error: { reason: "integer_out_of_range", key: "", value: raw },
				};
			}

			return { value: parsedValue };
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
			if (!Number.isFinite(parsedValue)) {
				return {
					value: undefined,
					error: { reason: "invalid_number", key: "", value: raw },
				};
			}
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
			const specType = (spec as { type?: string }).type ?? "unknown";
			throw new Error(`Unexpected field type "${specType}" in form schema`);
		}
	}
}
