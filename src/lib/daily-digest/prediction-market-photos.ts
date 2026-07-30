import type { Logger } from "../logging";
import { buildPredictionMarketCardSvg } from "../messaging/telegram/prediction-market-card";
import { renderChartPng } from "../messaging/telegram/render-png";
import type { TelegramSender } from "../messaging/types";
import { formatPredictionMarketCardCaption } from "../prediction-markets/format";
import type { PredictionMarketEventCard } from "../prediction-markets/types";
import type { DeliveryResult, IsoDateString, MinuteOfDay } from "../types";

/** Max prediction-market PNGs per digest (Lambda time + Telegram rate limits). */
const MAX_PREDICTION_MARKET_PHOTOS = 8;

export type PredictionMarketPhoto = {
	card: PredictionMarketEventCard;
	photo: Buffer;
};

export async function renderPredictionMarketPhotos(options: {
	cards: readonly PredictionMarketEventCard[];
	timeZone: string;
	use24Hour: boolean;
	logger: Logger;
	userId: string;
}): Promise<PredictionMarketPhoto[]> {
	const { cards, timeZone, use24Hour, logger, userId } = options;
	const out: PredictionMarketPhoto[] = [];
	for (const card of cards) {
		if (out.length >= MAX_PREDICTION_MARKET_PHOTOS) break;
		const svg = buildPredictionMarketCardSvg(card, { timeZone, use24Hour });
		if (svg === "") continue;
		const photo = await renderChartPng(svg);
		if (photo === null) {
			logger.warn("Prediction market card PNG render failed", {
				userId,
				marketKey: card.key,
				symbol: card.symbol ?? null,
			});
			continue;
		}
		out.push({ card, photo });
	}
	return out;
}

export async function sendPredictionMarketPhotos(options: {
	sender: TelegramSender;
	chatId: number;
	photos: readonly PredictionMarketPhoto[];
	logger: Logger;
	userId: string;
	scheduledDate: IsoDateString;
	scheduledMinutes: MinuteOfDay;
}): Promise<DeliveryResult | null> {
	const { sender, chatId, photos, logger, userId, scheduledDate, scheduledMinutes } = options;
	let blockedResult: DeliveryResult | null = null;
	for (const { card, photo } of photos) {
		const caption = formatPredictionMarketCardCaption(card);
		const result = await sender({
			chatId,
			text: caption.text,
			entities: caption.entities,
			photo,
			disableNotification: true,
		});
		if (!result.success) {
			logger.warn("Failed to send prediction market card photo", {
				userId,
				scheduledDate,
				scheduledMinutes,
				marketKey: card.key,
				errorCode: result.errorCode ?? null,
				error: result.error ?? null,
			});
			if (result.errorCode === "403") {
				blockedResult = result;
				break;
			}
		}
	}
	return blockedResult;
}
