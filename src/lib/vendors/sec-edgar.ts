/**
 * SEC EDGAR data.sec.gov client (submissions + company tickers).
 * Fair-access: descriptive User-Agent required; polite inter-request delay.
 */
import { setTimeout as realDelay } from "node:timers/promises";
import { rootLogger } from "../logging";
import {
	VENDOR_FETCH_MAX_RETRIES as MAX_RETRIES,
	VENDOR_FETCH_REQUEST_TIMEOUT_MS as REQUEST_TIMEOUT_MS,
	VENDOR_FETCH_RETRY_DELAY_MS as RETRY_DELAY_MS,
	SEC_COMPANY_TICKERS_URL,
	SEC_EDGAR_USER_AGENT,
	SEC_SUBMISSIONS_BASE_URL,
} from "./constants";
import { OPTIONAL_VENDOR_DEGRADED_CATEGORY } from "./optional-vendors";

/** Pause between submissions fetches — stay well under SEC's 10 req/s guidance. */
const INTER_REQUEST_DELAY_MS = 150;

export type SecFetchPolicy = {
	optional?: boolean;
};

type SecCompanyTickerRow = {
	cik_str: number;
	ticker: string;
	title: string;
};

export type SecRecentFiling = {
	accessionNumber: string;
	filingDate: string;
	form: string;
	primaryDocument: string | null;
};

/** Pad a CIK to the 10-digit zero-padded form used in submissions URLs. */
export function padCik(cik: string | number): string {
	const digits = String(cik).replace(/\D/g, "");
	return digits.padStart(10, "0");
}

/** Strip leading zeros for EDGAR Archives paths (CIK without padding). */
export function cikWithoutLeadingZeros(cik: string): string {
	const padded = padCik(cik);
	const stripped = padded.replace(/^0+/, "");
	return stripped.length > 0 ? stripped : "0";
}

/** True when the form is a material current report we surface in v1. */
export function isMaterialCurrentReportForm(form: string): boolean {
	const upper = form.trim().toUpperCase();
	return upper.startsWith("8-K") || upper.startsWith("6-K");
}

/**
 * Build a public EDGAR Archives URL for a filing.
 * Falls back to the filing index directory when primaryDocument is missing.
 */
/** Safe EDGAR primary-document path segment (reject markdown/URL breakouts). */
const SAFE_PRIMARY_DOCUMENT_RE = /^[A-Za-z0-9._-]+$/;

export function buildEdgarFilingUrl(options: {
	cik: string;
	accessionNumber: string;
	primaryDocument: string | null;
}): string {
	const cikPath = cikWithoutLeadingZeros(options.cik);
	const accessionPath = options.accessionNumber.replace(/-/g, "");
	const base = `https://www.sec.gov/Archives/edgar/data/${cikPath}/${accessionPath}`;
	const doc = options.primaryDocument?.trim();
	if (doc && SAFE_PRIMARY_DOCUMENT_RE.test(doc)) {
		return `${base}/${doc}`;
	}
	return `${base}/`;
}

/**
 * Resolve a Massive/app ticker against the SEC company_tickers map.
 * SEC uses hyphens for share classes (`BRK-B`); this app uses dots (`BRK.B`).
 */
export function resolveSecCikFromTickerMap(
	tickerMap: Map<string, string>,
	symbol: string,
): string | undefined {
	const upper = symbol.trim().toUpperCase();
	if (!upper) return undefined;
	return tickerMap.get(upper) ?? tickerMap.get(upper.replaceAll(".", "-"));
}

function computeRetryDelayMs(attempt: number): number {
	const base = RETRY_DELAY_MS * 2 ** (attempt - 1);
	const jitter = Math.random() * base * 0.5;
	return base + jitter;
}

async function secFetchJson(url: string, label: string, policy?: SecFetchPolicy): Promise<unknown> {
	const optional = policy?.optional === true;
	const failureCategory = optional ? OPTIONAL_VENDOR_DEGRADED_CATEGORY : "vendor_retry_exhausted";

	for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
		const isLastAttempt = attempt === MAX_RETRIES;
		try {
			const response = await fetch(url, {
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
				headers: {
					"User-Agent": SEC_EDGAR_USER_AGENT,
					Accept: "application/json",
				},
			});

			if (response.status === 429 || response.status >= 500) {
				if (!isLastAttempt) {
					await realDelay(computeRetryDelayMs(attempt));
					continue;
				}
				const context = {
					url,
					status: response.status,
					attempts: MAX_RETRIES,
					category: failureCategory,
				};
				if (optional) {
					rootLogger.warn(`SEC EDGAR ${label} exhausted retries`, context);
				} else {
					rootLogger.error(
						`SEC EDGAR ${label} exhausted retries`,
						context,
						new Error(`SEC EDGAR HTTP ${response.status}`),
					);
				}
				return null;
			}

			if (!response.ok) {
				const context = {
					url,
					status: response.status,
					category: failureCategory,
				};
				if (optional) {
					rootLogger.warn(`SEC EDGAR ${label} non-OK`, context);
				} else {
					rootLogger.error(
						`SEC EDGAR ${label} non-OK`,
						context,
						new Error(`SEC EDGAR HTTP ${response.status}`),
					);
				}
				return null;
			}

			return await response.json();
		} catch (error) {
			if (!isLastAttempt) {
				await realDelay(computeRetryDelayMs(attempt));
				continue;
			}
			const context = {
				url,
				attempts: MAX_RETRIES,
				category: failureCategory,
			};
			if (optional) {
				rootLogger.warn(`SEC EDGAR ${label} failed`, context);
			} else {
				rootLogger.error(
					`SEC EDGAR ${label} failed`,
					context,
					error instanceof Error ? error : new Error(String(error)),
				);
			}
			return null;
		}
	}
	return null;
}

/** Fetch the SEC company tickers map (ticker uppercase → 10-digit CIK). */
export async function fetchSecCompanyTickerMap(
	policy?: SecFetchPolicy,
): Promise<Map<string, string> | null> {
	const payload = await secFetchJson(SEC_COMPANY_TICKERS_URL, "company_tickers", policy);
	if (payload === null || typeof payload !== "object") {
		return null;
	}

	const map = new Map<string, string>();
	for (const value of Object.values(payload as Record<string, SecCompanyTickerRow>)) {
		if (
			!value ||
			typeof value !== "object" ||
			typeof value.ticker !== "string" ||
			(typeof value.cik_str !== "number" && typeof value.cik_str !== "string")
		) {
			continue;
		}
		const ticker = value.ticker.trim().toUpperCase();
		if (!ticker) continue;
		map.set(ticker, padCik(value.cik_str));
	}
	if (map.size === 0) {
		const context = { category: OPTIONAL_VENDOR_DEGRADED_CATEGORY };
		if (policy?.optional === true) {
			rootLogger.warn("SEC EDGAR company_tickers empty/unparseable", context);
		} else {
			rootLogger.error(
				"SEC EDGAR company_tickers empty/unparseable",
				context,
				new Error("SEC company_tickers map empty"),
			);
		}
		return null;
	}
	return map;
}

type SubmissionsRecent = {
	accessionNumber?: unknown;
	filingDate?: unknown;
	form?: unknown;
	primaryDocument?: unknown;
};

/**
 * Fetch recent submissions for a CIK and return material 8-K / 6-K filings
 * with filingDate on or after `sinceDate` (YYYY-MM-DD, inclusive).
 */
export async function fetchSecMaterialFilings(options: {
	cik: string;
	sinceDate: string;
	policy?: SecFetchPolicy;
}): Promise<SecRecentFiling[] | null> {
	const padded = padCik(options.cik);
	const url = `${SEC_SUBMISSIONS_BASE_URL}/CIK${padded}.json`;
	const payload = await secFetchJson(url, `submissions:${padded}`, options.policy);
	if (payload === null || typeof payload !== "object") {
		return null;
	}

	const filings = (payload as { filings?: { recent?: SubmissionsRecent } }).filings?.recent;
	if (!filings) {
		return [];
	}

	const accessionNumbers = Array.isArray(filings.accessionNumber) ? filings.accessionNumber : [];
	const filingDates = Array.isArray(filings.filingDate) ? filings.filingDate : [];
	const forms = Array.isArray(filings.form) ? filings.form : [];
	const primaryDocuments = Array.isArray(filings.primaryDocument) ? filings.primaryDocument : [];

	const length = Math.min(accessionNumbers.length, filingDates.length, forms.length);
	const out: SecRecentFiling[] = [];

	for (let i = 0; i < length; i++) {
		const accessionNumber = accessionNumbers[i];
		const filingDate = filingDates[i];
		const form = forms[i];
		if (
			typeof accessionNumber !== "string" ||
			typeof filingDate !== "string" ||
			typeof form !== "string"
		) {
			continue;
		}
		if (filingDate < options.sinceDate) {
			// Submissions are newest-first; once we pass the window we can stop.
			break;
		}
		if (!isMaterialCurrentReportForm(form)) {
			continue;
		}
		const primaryRaw = primaryDocuments[i];
		const primaryDocument =
			typeof primaryRaw === "string" && primaryRaw.trim().length > 0 ? primaryRaw.trim() : null;
		out.push({
			accessionNumber: accessionNumber.trim(),
			filingDate,
			form: form.trim(),
			primaryDocument,
		});
	}

	return out;
}

/** Delay between per-CIK submissions requests. */
export async function delayBetweenSecRequests(): Promise<void> {
	await realDelay(INTER_REQUEST_DELAY_MS);
}
