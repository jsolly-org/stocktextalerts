/* Temporary file to trigger Cursor afterFileEdit hooks. Delete after testing. */

// Triggers import-path-warn.sh: @ style import
import { DASHBOARD_FORM_ID } from "./constants";

// Triggers error-checking-warn.sh: string matching on error message
try {
	JSON.parse("x");
} catch (e) {
	if (e instanceof Error && e.message.includes("Unexpected")) throw e;
}

// Triggers env-var-warn.sh: presence check for required env (validated in middleware)
if (!process.env.RESEND_API_KEY) {
	throw new Error("missing");
}

export { DASHBOARD_FORM_ID };
