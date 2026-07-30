import type { Logger } from "../logging";
import { buildPredictionMarketCardSvg } from "../messaging/telegram/prediction-market-card";
import { renderChartPng } from "../messaging/telegram/render-png";
import type {
	TelegramMediaGroup,
	TelegramMediaGroupItem,
	TelegramMessage,
	TelegramSender,
} from "../messaging/types";
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

function buildPredictionMarketPhotoMessage(
	chatId: number,
	photos: readonly PredictionMarketPhoto[],
): TelegramMessage {
	if (photos.length === 1) {
		const { card, photo } = photos[0]!;
		const caption = formatPredictionMarketCardCaption(card);
		return {
			kind: "photo",
			chatId,
			text: caption.text,
			entities: caption.entities,
			photo,
			disableNotification: true,
		};
	}
	const [first, second, ...rest] = photos;
	if (first === undefined || second === undefined) {
		throw new Error("Expected at least two prediction-market photos for mediaGroup");
	}
	const toItem = (
		{ card, photo }: PredictionMarketPhoto,
		index: number,
	): TelegramMediaGroupItem => {
		if (index !== 0) return { photo };
		const caption = formatPredictionMarketCardCaption(card);
		return { photo, text: caption.text, entities: caption.entities };
	};
	const mediaGroup: TelegramMediaGroup = [
		toItem(first, 0),
		toItem(second, 1),
		...rest.map((p, i) => toItem(p, i + 2)),
	];
	return {
		kind: "mediaGroup",
		chatId,
		mediaGroup,
		disableNotification: true,
	};
}

/**
 * Send prediction-market PNGs: one `sendPhoto` when a single card rendered,
 * otherwise one `sendMediaGroup` album (Telegram requires 2–10 items).
 */
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
	if (photos.length === 0) return null;

	const result = await sender(buildPredictionMarketPhotoMessage(chatId, photos));
	if (!result.success) {
		logger.warn(
			photos.length === 1
				? "Failed to send prediction market card photo"
				: "Failed to send prediction market card album",
			{
				userId,
				scheduledDate,
				scheduledMinutes,
				photoCount: photos.length,
				marketKey: photos.length === 1 ? (photos[0]?.card.key ?? null) : null,
				errorCode: result.errorCode ?? null,
				error: result.error ?? null,
			},
		);
		if (result.errorCode === "403") return result;
	}
	return null;
}
