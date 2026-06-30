import { readRawSchemaData } from "./form-data";
import type { FormSchema, InferSchema, ParseOutcome } from "./schema";
import { processFields } from "./validate";

/**
 * Parse a `FormData` object with a schema, returning either typed data or structured errors.
 */
export function parseWithSchema<TSchema extends FormSchema>(
	formData: FormData,
	schema: TSchema,
): ParseOutcome<InferSchema<TSchema>> {
	const { keys, rawData, validationErrors } = readRawSchemaData(formData, schema);

	const [firstValidationError] = validationErrors;
	if (firstValidationError) {
		return {
			ok: false,
			error: firstValidationError,
			allErrors: validationErrors,
		};
	}

	const { errors, output } = processFields(keys, rawData, schema);

	const [firstError] = errors;
	if (firstError) {
		return {
			ok: false,
			error: firstError,
			allErrors: errors,
		};
	}

	return {
		ok: true,
		data: output as InferSchema<TSchema>,
	};
}
