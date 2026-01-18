import type { Database } from "./generated/database.types";
import type { AppSupabaseClient } from "./supabase";

type DbStockRow = Database["public"]["Tables"]["stocks"]["Row"];
type DbUserStockRow = Database["public"]["Tables"]["user_stocks"]["Row"];

export type Stock = DbStockRow;
export type UserStock = Pick<DbUserStockRow, "symbol" | "created_at">;

export async function getUserStocks(
	supabase: AppSupabaseClient,
	userId: string,
): Promise<UserStock[]> {
	const { data, error } = await supabase
		.from("user_stocks")
		.select("symbol, created_at")
		.eq("user_id", userId)
		.order("created_at", { ascending: false });

	if (error) throw error;

	return data || [];
}
