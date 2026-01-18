import { processFields, readRawSchemaData } from "./coercion";
import type { FormSchema, InferSchema, ParseOutcome } from "./schema";

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
	const transformed = transform ? transform(baseResult) : baseResult;

	return {
		ok: true,
		data: transformed,
	};
}
