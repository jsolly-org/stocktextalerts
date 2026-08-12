import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	US_EQUITY_TRADE_CLOSE_EASTERN_MINUTES,
	US_EQUITY_TRADE_OPEN_EASTERN_MINUTES,
	US_MARKET_EARLIEST_NOTIFICATION_EASTERN_MINUTES,
	US_MARKET_LATEST_NOTIFICATION_EASTERN_MINUTES,
} from "../../../src/lib/constants";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const templatePath = path.join(repoRoot, "aws", "template.yaml");

/**
 * Dual-pacemaker lock with asset-buyer: STA stays a 1-minute poller with fixed
 * human vs lambda windows. Buyer cron is :50 ET; STA owns 04:00–04:50 / 19:50–20:00 edges.
 */
describe("dual-pacemaker schedule / window contract", () => {
	it("locks schedule rate(1 minute) and equity/human session windows", () => {
		const yaml = readFileSync(templatePath, "utf8");
		expect(yaml).toMatch(/ScheduleExpression:\s*"rate\(1 minute\)"/);

		// Lambda / stock-buyer equity window [04:00, 20:00) ET
		expect(US_EQUITY_TRADE_OPEN_EASTERN_MINUTES).toBe(4 * 60);
		expect(US_EQUITY_TRADE_CLOSE_EASTERN_MINUTES).toBe(20 * 60);

		// Human email/Telegram [04:30, 19:30] ET inclusive
		expect(US_MARKET_EARLIEST_NOTIFICATION_EASTERN_MINUTES).toBe(4 * 60 + 30);
		expect(US_MARKET_LATEST_NOTIFICATION_EASTERN_MINUTES).toBe(19 * 60 + 30);
	});
});
