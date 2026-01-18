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
	/**
	 * Accepted truthy string values.
	 * Defaults to ["on", "true", "1"].
	 */
	truthyValues?: readonly string[];
	/**
	 * Accepted falsy string values.
	 * Defaults to ["off", "false", "0"].
	 */
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

type JsonStringArrayFieldSpec = {
	type: "json_string_array";
	required?: boolean;
};

export type FieldSpec<TValues extends readonly string[] = readonly string[]> =
	| BooleanFieldSpec
	| StringFieldSpec
	| EnumFieldSpec<TValues>
	| TimezoneFieldSpec
	| IntegerFieldSpec
	| NumberFieldSpec
	| TimeFieldSpec
	| JsonStringArrayFieldSpec;

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
	[K in keyof TSchema as TSchema[K] extends { required: true }
		? K
		: never]: InferField<TSchema[K]>;
};

type OptionalFields<TSchema extends FormSchema> = {
	[K in keyof TSchema as TSchema[K] extends { required: true }
		? never
		: K]?: InferField<TSchema[K]>;
};

export type InferSchema<TSchema extends FormSchema> = RequiredFields<TSchema> &
	OptionalFields<TSchema>;

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

export interface FormIssue {
	reason: string;
	key: string;
	[detail: string]: unknown;
}
