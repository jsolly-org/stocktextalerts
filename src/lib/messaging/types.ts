import type { InlineKeyboardMarkup, MessageEntity } from "grammy/types";
import type { Database } from "../db/generated/database.types";
import type { TopMover } from "../market-data/types";
import type {
	PredictionMarketReading,
	PredictionMarketsDigestContent,
} from "../prediction-markets/types";
import type { MarketClosureInfo } from "../time/types";
import type { DeliveryResult } from "../types";
import type { SparklineData } from "./parts/sparkline";

/** Structured market-wide top movers — raw data each channel renders itself. */
export type TopMoversData = {
	gainers: TopMover[];
	losers: TopMover[];
};

export interface EmailRequest {
	to: string;
	subject: string;
	body: string;
	html?: string;
	idempotencyKey?: string;
	replyTo?: string;
	userId?: string;
}

export type EmailSender = (request: EmailRequest) => Promise<DeliveryResult>;

/** One photo in a Telegram media-group album (`sendMediaGroup`, 2–10 items). */
export type TelegramMediaGroupItem = {
	photo: Buffer;
	/** Caption for this item; Telegram only displays the first item's caption. */
	text?: string;
	entities?: MessageEntity[];
};

/** At least two items — Telegram rejects shorter media groups. */
export type TelegramMediaGroup = readonly [
	TelegramMediaGroupItem,
	TelegramMediaGroupItem,
	...TelegramMediaGroupItem[],
];

type TelegramMessageBase = {
	chatId: number | string;
	/** Silent delivery (e.g. routine digest) — maps to Telegram's disable_notification. */
	disableNotification?: boolean;
};

/** Plain-text `sendMessage` (formatting via out-of-band entities). */
type TelegramTextMessage = TelegramMessageBase & {
	kind: "text";
	text: string;
	entities?: MessageEntity[];
	replyMarkup?: InlineKeyboardMarkup;
};

/** Single `sendPhoto` with `text` as the caption (≤1024 chars). */
type TelegramPhotoMessage = TelegramMessageBase & {
	kind: "photo";
	photo: Buffer;
	text: string;
	entities?: MessageEntity[];
	replyMarkup?: InlineKeyboardMarkup;
};

/** `sendMediaGroup` album — no `reply_markup` (Telegram API limitation). */
type TelegramMediaGroupMessage = TelegramMessageBase & {
	kind: "mediaGroup";
	mediaGroup: TelegramMediaGroup;
};

/** Fully-rendered outbound Telegram message — mutually exclusive send modes. */
export type TelegramMessage =
	| TelegramTextMessage
	| TelegramPhotoMessage
	| TelegramMediaGroupMessage;

export type TelegramSender = (message: TelegramMessage) => Promise<DeliveryResult>;

/** Optional Grok/Massive/Finnhub extras appended to digest or scheduled notifications. */
export type NotificationExtras = {
	news?: string | null;
	rumors?: string | null;
	/**
	 * Structured prediction-market readings; channel formatters render text/HTML.
	 * Prefer `predictionMarketsDigest` when asset + macro grouping is available.
	 */
	predictionMarkets?: PredictionMarketReading[] | null;
	/** Grouped asset + macro prediction markets for the digest strip. */
	predictionMarketsDigest?: PredictionMarketsDigestContent | null;
	analyst?: string | null;
	insider?: string | null;
	topMovers?: TopMoversData | null;
	citations?: string[];
};

/** Minimal user shape needed to send email. */
export type EmailUser = Pick<Database["public"]["Tables"]["users"]["Row"], "id" | "email">;

/** Optional context for email rendering: sparklines, logos, market closure banners. */
export interface EmailFormatContext {
	getSparkline?: (symbol: string) => SparklineData | null | undefined;
	marketClosureInfo?: MarketClosureInfo | null;
	getLogoHtml?: (symbol: string) => string | undefined;
}
