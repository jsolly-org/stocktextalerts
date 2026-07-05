import type { FieldSpec, FormIssue } from "./schema";

const DEFAULT_TRUTHY_VALUES = ["on", "true", "1"];
const DEFAULT_FALSY_VALUES = ["off", "false", "0"];
const TIME_PATTERN = /^([0-1]?[0-9]|2[0-3]):([0-5][0-9])$/;

/**
 * Coerce a raw string form value into the typed value defined by the field spec.
 *
 * Returns `{ value: undefined }` for empty optional fields and includes a structured `FormIssue`
 * when coercion fails.
 *
 * For `json_string_array` fields: enforces a max raw string size of 50KB (DoS mitigation) and
 * a max parsed array length (default 100, overridable via spec.maxLength). Rejects non-arrays
 * and arrays containing non-string elements.
 */
export function coerceValue(spec: FieldSpec, raw: string): { value: unknown; error?: FormIssue } {
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
			// Trimming is only used for untrusted external input (e.g., inbound webhooks).
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

			const match = raw.match(TIME_PATTERN);
			if (!match) {
				return {
					value: undefined,
					error: { reason: "invalid_time", key: "", value: raw },
				};
			}

			const hours = Number.parseInt(match[1] ?? "", 10);
			const minutes = Number.parseInt(match[2] ?? "", 10);
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
			/** IANA timezone names are ~50 chars max; cap to prevent DoS from oversized payloads. */
			const MAX_TIMEZONE_LENGTH = 64;
			if (raw.length > MAX_TIMEZONE_LENGTH) {
				return {
					value: undefined,
					error: {
						reason: "timezone_too_long",
						key: "",
						value: "[timezone exceeds 64 character limit]",
					},
				};
			}
			/** DB enforces has_no_whitespace(timezone); reject early for clearer errors. */
			if (/\s/.test(raw)) {
				return {
					value: undefined,
					error: { reason: "invalid_timezone", key: "", value: raw },
				};
			}
			return { value: raw };
		}
		case "json_string_array": {
			if (raw === "") {
				return { value: undefined };
			}

			const maxLength = spec.maxLength ?? 100;
			/** Max raw JSON string size (bytes) to limit parse cost and memory use. */
			const maxRawLength = 50_000;

			if (raw.length > maxRawLength) {
				return {
					value: undefined,
					error: {
						reason: "json_array_too_large",
						key: "",
						value: "[payload exceeds 50KB limit]",
					},
				};
			}

			try {
				const parsedValue = JSON.parse(raw);

				if (!Array.isArray(parsedValue)) {
					return {
						value: undefined,
						error: { reason: "invalid_json_array", key: "", value: raw },
					};
				}

				if (parsedValue.length > maxLength) {
					return {
						value: undefined,
						error: {
							reason: "json_array_too_long",
							key: "",
							value: raw,
						},
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
