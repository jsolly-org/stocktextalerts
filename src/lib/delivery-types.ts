/** Result of attempting to deliver a single notification (email or SMS). */
export type DeliveryResult =
	| { success: true; messageSid?: string }
	| { success: false; error: string; errorCode?: string };

/** Per-notification processing metadata used for auditing/debugging. */
export type ProcessingStats =
	| { sent: true; logged: boolean }
	| { sent: false; logged: boolean; error: string; errorCode?: string };
