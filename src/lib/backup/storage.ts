import { gzipSync } from "node:zlib";
import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import type { BackupManifest } from "./manifest";

export type BackupPayload = { manifest: BackupManifest; tables: Record<string, string> };

/** gzip(JSON envelope). Dependency-light container — restore parses JSON then
 * COPYs each table string FROM STDIN. */
export function packBackup(payload: BackupPayload): Buffer {
	return gzipSync(Buffer.from(JSON.stringify(payload), "utf8"));
}

export function objectKey(takenAt: string): string {
	return `user-settings/${takenAt}.json.gz`;
}

export async function getConnectionString(parameterName: string): Promise<string> {
	const ssm = new SSMClient({});
	const res = await ssm.send(
		new GetParameterCommand({ Name: parameterName, WithDecryption: true }),
	);
	const value = res.Parameter?.Value;
	if (!value) throw new Error(`SSM parameter ${parameterName} is empty`);
	return value;
}

export async function putBackup(opts: { bucket: string; payload: BackupPayload }): Promise<string> {
	const s3 = new S3Client({});
	const key = objectKey(opts.payload.manifest.taken_at);
	await s3.send(
		new PutObjectCommand({
			Bucket: opts.bucket,
			Key: key,
			Body: packBackup(opts.payload),
			ContentType: "application/gzip",
		}),
	);
	return key;
}

/** Heartbeat metric; the staleness alarm treats missing data as breaching. */
export async function emitHeartbeat(): Promise<void> {
	const cw = new CloudWatchClient({});
	await cw.send(
		new PutMetricDataCommand({
			Namespace: "stocktextalerts/Backup",
			MetricData: [{ MetricName: "BackupSuccess", Value: 1, Unit: "Count" }],
		}),
	);
}
