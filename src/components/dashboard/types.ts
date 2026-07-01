import type { UserAsset } from "../../lib/db/types";

export type InitialAsset = Pick<UserAsset, "symbol" | "name" | "type" | "icon_url">;
