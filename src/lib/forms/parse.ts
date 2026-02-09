import { readRawSchemaData } from "./form-data";
import type { FormSchema, InferSchema, ParseOutcome } from "./schema";
import { processFields } from "./validate";

/**
 * Parse a `FormData` object with a schema, returning either typed data or structured errors.
 *
 * When `transform` is provided, it runs after validation and may map the parsed result into
 * a different shape (transform exceptions are captured as `transform_failed`).
 */
export function parseWithSchema<TSchema extends FormSchema>(
	formData: FormData,
	schema: TSchema,
): ParseOutcome<InferSchema<TSchema>>;
export function parseWithSchema<TSchema extends FormSchema, TResult>(
	formData: FormData,
	schema: TSchema,
	transform: (data: InferSchema<TSchema>) => TResult,
): ParseOutcome<TResult>;
export function parseWithSchema<TSchema extends FormSchema, TResult>(
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
	try {
		const transformed = transform ? transform(baseResult) : baseResult;
		return {
			ok: true,
			data: transformed,
		};
	} catch (error) {
		const parseError = {
			reason: "transform_failed" as const,
			key: "",
			message: error instanceof Error ? error.message : String(error),
		};
		return {
			ok: false,
			error: parseError,
			allErrors: [parseError],
		};
	}
}
