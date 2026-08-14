/** A per-(user, symbol) price-move alert threshold. Row presence means the user
 *  has opted this asset into price-move alerts at the given percent value. */
export interface PriceMoveThreshold {
	symbol: string;
	value: number;
}
