import type { UserAsset } from "../../../lib/db";

export type InitialAsset = Pick<UserAsset, "symbol" | "name" | "type" | "icon_url">;
