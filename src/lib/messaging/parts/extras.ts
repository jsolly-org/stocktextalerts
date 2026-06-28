/** Optional Grok/Massive/Finnhub extras appended to digest or scheduled notifications. */
export type NotificationExtras = {
	news?: string | null;
	rumors?: string | null;
	analyst?: string | null;
	insider?: string | null;
	topMovers?: string | null;
	citations?: string[];
};
