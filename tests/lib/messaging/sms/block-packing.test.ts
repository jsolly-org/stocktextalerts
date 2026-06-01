import { describe, expect, it } from "vitest";
import type {
	AtomicSmsBlock,
	SmsBlock,
	SplittableSmsBlock,
} from "../../../../src/lib/messaging/sms/block-packing";
import {
	packSmsBlocks,
	SMS_BODY_CHAR_BUDGET,
} from "../../../../src/lib/messaging/sms/block-packing";

describe("packSmsBlocks", () => {
	it("moves an atomic block to the next SMS body when it would exceed the budget", () => {
		const first = "A".repeat(SMS_BODY_CHAR_BUDGET - 20);
		const second = "📊 Analyst Consensus\nLDOS: 8 Buy, 11 Hold, 0 Sell";
		const blocks: SmsBlock[] = [
			{ id: "assets", boundary: "atomic", text: first },
			{ id: "analystConsensus", boundary: "atomic", text: second },
		];

		const messages = packSmsBlocks(blocks);

		expect(messages).toHaveLength(2);
		expect(messages[0]).toBe(first);
		expect(messages[1]).toBe(second);
	});

	it("splits a splittable block only between child entries and repeats the header", () => {
		const child = "AAPL — $187.42 (+1.23%) past 7 days: ▁▂▃▅▇";
		const block: SplittableSmsBlock = {
			id: "assets",
			boundary: "split-between-children",
			header: "💰 Your Assets",
			children: Array.from({ length: 5 }, (_, index) => `${child} ${index + 1}`),
			childSeparator: "\n\n",
		};
		const messages = packSmsBlocks([block], 160);

		expect(messages.length).toBeGreaterThan(1);
		for (const message of messages) {
			expect(message).toMatch(/^💰 Your Assets\n/);
			expect(message).not.toContain("AAPL — $187.42 (+1.23%) past 7 days: ▁▂\n\n▃");
		}
	});

	it("drops empty atomic and splittable blocks before packing", () => {
		const messages = packSmsBlocks([
			{ id: "empty-atomic", boundary: "atomic", text: "   " },
			{
				id: "empty-splittable",
				boundary: "split-between-children",
				header: "💰 Your Assets",
				children: ["", "  "],
			},
			{ id: "footer", boundary: "atomic", text: "Reply STOP to opt out." },
		]);

		expect(messages).toEqual(["Reply STOP to opt out."]);
	});

	it("keeps an oversized atomic block whole rather than splitting arbitrary text", () => {
		const text = `📊 Analyst Consensus\n${"LDOS: 8 Buy, 11 Hold, 0 Sell\n".repeat(80)}`;
		const block: AtomicSmsBlock = { id: "analystConsensus", boundary: "atomic", text };

		const messages = packSmsBlocks([block], 100);

		expect(messages).toEqual([text.trim()]);
	});
});
