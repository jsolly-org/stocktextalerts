import { SMS_BODY_CHAR_BUDGET } from "./constants";
import type { SmsBlock } from "./types";

const BODY_BLOCK_SEPARATOR = "\n\n";

export function packSmsBlocks(blocks: SmsBlock[], maxChars = SMS_BODY_CHAR_BUDGET): string[] {
	const messages: string[] = [];
	let currentBody = "";

	const flushCurrentBody = () => {
		if (!currentBody) {
			return;
		}

		messages.push(currentBody.trim());
		currentBody = "";
	};

	const canAppendBlock = (text: string) => {
		if (!currentBody) {
			return text.length <= maxChars;
		}

		return `${currentBody}${BODY_BLOCK_SEPARATOR}${text}`.length <= maxChars;
	};

	const appendBlock = (text: string) => {
		const normalizedText = text.trim();
		if (!normalizedText) {
			return;
		}

		if (canAppendBlock(normalizedText)) {
			currentBody = currentBody
				? `${currentBody}${BODY_BLOCK_SEPARATOR}${normalizedText}`
				: normalizedText;
			return;
		}

		flushCurrentBody();
		currentBody = normalizedText;
	};

	for (const block of blocks) {
		if (block.boundary === "atomic") {
			appendBlock(normalizeText(block.text));
			continue;
		}

		const children = block.children.map(normalizeText).filter(Boolean);
		if (children.length === 0) {
			continue;
		}

		const childSeparator = block.childSeparator ?? "\n";
		let chunkChildren: string[] = [];

		const startChunk = (child: string) => {
			const singleChildChunk = renderSplittableChunk(block.header, [child], childSeparator);
			if (!canAppendBlock(singleChildChunk)) {
				flushCurrentBody();
			}

			chunkChildren = [child];
		};

		for (const child of children) {
			if (chunkChildren.length === 0) {
				startChunk(child);
				continue;
			}

			const candidateChunk = renderSplittableChunk(
				block.header,
				[...chunkChildren, child],
				childSeparator,
			);
			if (canAppendBlock(candidateChunk)) {
				chunkChildren.push(child);
				continue;
			}

			appendBlock(renderSplittableChunk(block.header, chunkChildren, childSeparator));
			startChunk(child);
		}

		appendBlock(renderSplittableChunk(block.header, chunkChildren, childSeparator));
	}

	if (currentBody) {
		messages.push(currentBody.trim());
	}

	return messages.filter(Boolean);
}

function normalizeText(text: string | null | undefined): string {
	return (text ?? "").trim();
}

function renderSplittableChunk(header: string, children: string[], childSeparator: string): string {
	return `${header.trim()}\n${children.join(childSeparator)}`.trim();
}
