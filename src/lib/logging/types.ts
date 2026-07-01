export type LogContext = Record<string, unknown> & {
	requestId?: string;
};

/** Minimal structured logger interface used across the app. */
export type Logger = {
	debug: (message: string, context?: LogContext) => void;
	info: (message: string, context?: LogContext, error?: unknown) => void;
	warn: (message: string, context?: LogContext, error?: unknown) => void;
	error: (message: string, context?: LogContext, error?: unknown) => void;
};
