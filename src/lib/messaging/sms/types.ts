import type { DeliveryResult } from "../../types";

export interface SmsRequest {
	to: string;
	body: string;
	from?: string;
}

export type SmsSender = (request: SmsRequest) => Promise<DeliveryResult>;

interface SmsSenderResult {
	sender: SmsSender;
}

export type SmsSenderFactory = () => SmsSenderResult;

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
