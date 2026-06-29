/* =============
US market session & notification scheduling
============= */

/** Default time (minutes since local midnight) for market updates. */
export const DEFAULT_MARKET_UPDATE_TIME_MINUTES = 9 * 60; // 9:00 AM local time (minutes since local midnight)

/** US market open time in ET (minutes since midnight). */
export const US_MARKET_OPEN_EASTERN_MINUTES = 9 * 60 + 30;
/** US market close time in ET (minutes since midnight). */
export const US_MARKET_CLOSE_EASTERN_MINUTES = 16 * 60; // 4:00 PM ET
/** 30 min before open — used as the default preset time for daily digests. */
export const US_BEFORE_OPEN_EASTERN_MINUTES = 9 * 60; // 9:00 AM ET
/** 30 min after open — used as the default preset time for scheduled price notifications. */
export const US_AFTER_OPEN_EASTERN_MINUTES = 10 * 60; // 10:00 AM ET
/** Earliest allowed scheduled price notification time in ET (minutes since midnight). 4:30 AM ET = pre-market entry + 30 min outer buffer. */
export const US_MARKET_EARLIEST_NOTIFICATION_EASTERN_MINUTES = 4 * 60 + 30; // 4:30 AM ET, minute 270
/** Latest allowed scheduled price notification time in ET (minutes since midnight). 7:30 PM ET = after-hours close - 30 min outer buffer. */
export const US_MARKET_LATEST_NOTIFICATION_EASTERN_MINUTES = 19 * 60 + 30; // 7:30 PM ET, minute 1170
/** IANA timezone for the US market session constants (ET). */
export const US_MARKET_TIMEZONE = "America/New_York";
