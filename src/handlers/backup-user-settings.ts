import type { Context, ScheduledEvent } from "aws-lambda";
import { exportSnapshot } from "../lib/backup/export";
import { emitHeartbeat, getConnectionString, putBackup } from "../lib/backup/storage";
import { requireEnv } from "../lib/db/env";
import { createLogger } from "../lib/logging";
import { runWithRequestContext } from "../lib/logging/request-context";

export async function handler(event: ScheduledEvent, context: Context): Promise<void> {
	return runWithRequestContext(context.awsRequestId, async () => {
		const logger = createLogger({
			source: "lambda",
			function: "backup-user-settings",
			gitSha: process.env.GIT_SHA,
		});
		logger.info("Lambda invoke", {
			action: "lambda_invoke",
			eventId: event.id,
			eventTime: event.time,
		});

		const bucket = requireEnv("BACKUP_BUCKET");
		const ssmParam = requireEnv("BACKUP_CONNECTION_SSM_PARAM");

		const connectionString = await getConnectionString(ssmParam);
		const snapshot = await exportSnapshot({ connectionString });
		const key = await putBackup({ bucket, payload: snapshot });
		await emitHeartbeat();

		logger.info("Backup written", {
			action: "backup_written",
			key,
			rowCounts: snapshot.manifest.row_counts,
			schemaVersion: snapshot.manifest.schema_version,
		});
	});
}
