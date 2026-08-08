import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { readEnv } from "../../db/env";
import { createLogger } from "../../logging";

const logger = createLogger({ module: "asset-buyer-wakeup" });

const HEARTBEAT_ARN_SSM_PATH = "/asset-buyer/heartbeat-arn";

export type AssetBuyerWakeupPayload = {
	source: "sta_flat_price_alert";
	prioritizeTicker: string;
	ticker: string;
	direction: "up" | "down" | "flat";
	triggerPercent: number;
	isAcceleration: boolean;
	asOf: string;
};

let lambdaClient: LambdaClient | undefined;
let ssmClient: SSMClient | undefined;

function getLambdaClient(): LambdaClient {
	if (!lambdaClient) {
		lambdaClient = new LambdaClient({});
	}
	return lambdaClient;
}

function getSsmClient(): SSMClient {
	if (!ssmClient) {
		ssmClient = new SSMClient({});
	}
	return ssmClient;
}

/** Resolve heartbeat ARN: env first, then optional SSM fallback. */
async function resolveAssetBuyerHeartbeatArn(): Promise<string | undefined> {
	const fromEnv = readEnv("ASSET_BUYER_HEARTBEAT_ARN");
	if (fromEnv) return fromEnv;

	try {
		const out = await getSsmClient().send(
			new GetParameterCommand({ Name: HEARTBEAT_ARN_SSM_PATH }),
		);
		const value = out.Parameter?.Value?.trim();
		return value || undefined;
	} catch (err) {
		logger.warn(
			"ASSET_BUYER_HEARTBEAT_ARN unset and SSM fallback failed",
			{ ssmPath: HEARTBEAT_ARN_SSM_PATH },
			err,
		);
		return undefined;
	}
}

export function directionFromTriggerPercent(triggerPercent: number): "up" | "down" | "flat" {
	if (triggerPercent > 0) return "up";
	if (triggerPercent < 0) return "down";
	return "flat";
}

/**
 * Async-invoke asset-buyer heartbeat for a flat price alert on a `lambda`
 * delivery-channel user. Fail-open: missing ARN or invoke errors warn + return
 * false so human STA alerts are never blocked.
 */
export async function wakeupAssetBuyerFromFlatAlert(options: {
	symbol: string;
	triggerPercent: number;
	isAcceleration: boolean;
	asOf?: string;
	/** Injectable for unit tests. */
	invoke?: (arn: string, payload: AssetBuyerWakeupPayload) => Promise<void>;
	resolveArn?: () => Promise<string | undefined>;
}): Promise<boolean> {
	const {
		symbol,
		triggerPercent,
		isAcceleration,
		asOf = new Date().toISOString(),
		invoke,
		resolveArn = resolveAssetBuyerHeartbeatArn,
	} = options;

	const arn = await resolveArn();
	if (!arn) {
		logger.warn("Skipping asset-buyer wakeup: heartbeat ARN missing", { symbol });
		return false;
	}

	const ticker = symbol.trim().toUpperCase();
	const payload: AssetBuyerWakeupPayload = {
		source: "sta_flat_price_alert",
		prioritizeTicker: ticker,
		ticker,
		direction: directionFromTriggerPercent(triggerPercent),
		triggerPercent,
		isAcceleration,
		asOf,
	};

	try {
		if (invoke) {
			await invoke(arn, payload);
		} else {
			await getLambdaClient().send(
				new InvokeCommand({
					FunctionName: arn,
					InvocationType: "Event",
					Payload: Buffer.from(JSON.stringify(payload)),
				}),
			);
		}
		logger.info("Asset-buyer heartbeat wakeup invoked", {
			symbol: ticker,
			direction: payload.direction,
			triggerPercent,
			isAcceleration,
		});
		return true;
	} catch (err) {
		logger.warn("Asset-buyer heartbeat wakeup failed (fail-open)", { symbol: ticker }, err);
		return false;
	}
}
