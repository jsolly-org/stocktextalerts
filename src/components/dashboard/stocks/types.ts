import type { UserStock } from "../../../lib/db";

export type InitialStock = Pick<UserStock, "symbol" | "name">;
