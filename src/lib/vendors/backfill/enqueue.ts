import type {
	AssetEventsBackfillMessage,
	DailyClosesBackfillMessage,
	NewSymbolWarmupBackfillMessage,
	PriceHistoryStoreBackfillMessage,
	VendorBackfillMessage,
} from "./messages";
import { sendVendorBackfillMessage } from "./sqs";

async function enqueue(message: VendorBackfillMessage): Promise<boolean> {
	return sendVendorBackfillMessage(JSON.stringify(message));
}

export async function enqueueAssetEventsIngestRetry(
	message: Omit<AssetEventsBackfillMessage, "kind">,
): Promise<boolean> {
	return enqueue({ kind: "asset-events", ...message });
}

export async function enqueueDailyCloseBackfill(
	message: Omit<DailyClosesBackfillMessage, "kind">,
): Promise<boolean> {
	return enqueue({ kind: "daily-closes", ...message });
}

export async function enqueuePriceHistoryStoreRetry(
	message: Omit<PriceHistoryStoreBackfillMessage, "kind">,
): Promise<boolean> {
	return enqueue({ kind: "price-history-store", ...message });
}

export async function enqueueNewSymbolWarmup(
	message: Omit<NewSymbolWarmupBackfillMessage, "kind">,
): Promise<boolean> {
	return enqueue({ kind: "new-symbol-warmup", ...message });
}
