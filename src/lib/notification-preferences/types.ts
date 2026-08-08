/** Raw `notification_preferences` row shape from PostgREST selects. */
export type NotificationPreferenceDbRow = {
	user_id: string;
	notification_type: string;
	content: string;
	enabled: boolean;
};
