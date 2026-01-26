import { formatMessage } from "../constants";

export function getAuthErrorMessage(error: string | null): string {
	return formatMessage(error);
}

export function getAuthSuccessMessage(code: string | null): string {
	return formatMessage(code);
}
