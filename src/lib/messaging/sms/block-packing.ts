export const SMS_BODY_CHAR_BUDGET = 1500;

export type AtomicSmsBlock = {
	id: string;
	boundary: "atomic";
	text: string | null | undefined;
};

export type SplittableSmsBlock = {
	id: string;
	boundary: "split-between-children";
	header: string;
	children: Array<string | null | undefined>;
	childSeparator?: string;
};

export type SmsBlock = AtomicSmsBlock | SplittableSmsBlock;

const BODY_BLOCK_SEPARATOR = "\n\n";

export function packSmsBlocks(blocks: SmsBlock[], maxChars = SMS_BODY_CHAR_BUDGET): string[] {
	const messages: string[] = [];
	let currentBody = "";

	const appendBlock = (text: string) => {
		const normalizedText = text.trim();
		if (!normalizedText) {
			return;
		}

		if (!currentBody) {
			currentBody = normalizedText;
			return;
		}

		const combinedBody = `${currentBody}${BODY_BLOCK_SEPARATOR}${normalizedText}`;
		if (combinedBody.length <= maxChars) {
			currentBody = combinedBody;
			return;
		}

		messages.push(currentBody.trim());
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

		for (const child of children) {
			if (chunkChildren.length === 0) {
				chunkChildren = [child];
				continue;
			}

			const candidateChunk = renderSplittableChunk(
				block.header,
				[...chunkChildren, child],
				childSeparator,
			);
			if (candidateChunk.length <= maxChars) {
				chunkChildren.push(child);
				continue;
			}

			appendBlock(renderSplittableChunk(block.header, chunkChildren, childSeparator));
			chunkChildren = [child];
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
