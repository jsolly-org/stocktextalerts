/* =============
Schema types
============= */
type StringFieldSpec = {
	type: "string";
	required?: boolean;
	trim?: boolean;
};

type BooleanFieldSpec = {
	type: "boolean";
	required?: boolean;
	truthyValues?: readonly string[];
	falsyValues?: readonly string[];
};

type EnumFieldSpec<TValues extends readonly string[]> = {
	type: "enum";
	values: TValues;
	required?: boolean;
};

type TimezoneFieldSpec = {
	type: "timezone";
	required?: boolean;
};

type IntegerFieldSpec = {
	type: "integer";
	required?: boolean;
};

type NumberFieldSpec = {
	type: "number";
	required?: boolean;
};

type TimeFieldSpec = {
	type: "time";
	required?: boolean;
};

/** JSON string array field: parses raw JSON into string[]. Enforces size limits for DoS mitigation. */
type JsonStringArrayFieldSpec = {
	type: "json_string_array";
	required?: boolean;
	/** Max array length to prevent DoS from oversized payloads. Default 100. */
	maxLength?: number;
};

/** Supported form-field spec variants used by the lightweight form parser. */
export type FieldSpec<TValues extends readonly string[] = readonly string[]> =
	| BooleanFieldSpec
	| StringFieldSpec
	| EnumFieldSpec<TValues>
	| TimezoneFieldSpec
	| IntegerFieldSpec
	| NumberFieldSpec
	| TimeFieldSpec
	| JsonStringArrayFieldSpec;

/** A form schema mapping field keys to their validation specs. */
export type FormSchema = Record<string, FieldSpec>;

type NonEnumFieldTypeMap = {
	boolean: boolean;
	integer: number;
	number: number;
	time: number;
	timezone: string;
	json_string_array: string[];
	string: string;
};

type InferNonEnumField<TSpec> = TSpec extends { type: infer TType }
	? TType extends keyof NonEnumFieldTypeMap
		? NonEnumFieldTypeMap[TType]
		: string
	: string;

type InferField<TSpec> = TSpec extends {
	type: "enum";
	values: infer V extends readonly string[];
}
	? V[number]
	: InferNonEnumField<TSpec>;

type RequiredFields<TSchema extends FormSchema> = {
	[K in keyof TSchema as TSchema[K] extends { required: true } ? K : never]: InferField<TSchema[K]>;
};

type OptionalFields<TSchema extends FormSchema> = {
	[K in keyof TSchema as TSchema[K] extends { required: true } ? never : K]?: InferField<
		TSchema[K]
	>;
};

export type InferSchema<TSchema extends FormSchema> = RequiredFields<TSchema> &
	OptionalFields<TSchema>;

/** Standard result shape returned from parsing a form submission. */
export type ParseOutcome<TResult> =
	| {
			ok: true;
			data: TResult;
	  }
	| {
			ok: false;
			error: FormIssue;
			allErrors: FormIssue[];
	  };

/** A single form validation issue associated with a specific key. */
export interface FormIssue {
	reason: string;
	key: string;
	[detail: string]: unknown;
}
