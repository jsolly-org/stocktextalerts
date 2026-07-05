import type { PriceMoveThresholdUnit } from "../../db/types";

/** A per-(user, symbol) price-move alert threshold. Row presence means the user
 *  has opted this asset into price-move alerts at the given value + unit. */
export interface PriceMoveThreshold {
	symbol: string;
	value: number;
	unit: PriceMoveThresholdUnit;
}
