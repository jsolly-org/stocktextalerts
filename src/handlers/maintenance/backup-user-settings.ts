/**
 * User-settings backup (EventBridge: every five hours). Exports notification
 * preferences and related tables from Postgres to S3 as CSV snapshots with a
 * manifest, then emits a CloudWatch heartbeat for staleness monitoring.
 */
import type { Context, ScheduledEvent } from "aws-lambda";
import { exportSnapshot } from "../../lib/backup/export";
import { emitHeartbeat, getConnectionString, putBackup } from "../../lib/backup/storage";
import { requireEnv } from "../../lib/db/env";
import { createLogger } from "../../lib/logging";
import { createErrorForLogging } from "../../lib/logging/errors";
import { runLambda } from "../../lib/logging/request-context";

export async function handler(event: ScheduledEvent, context: Context): Promise<void> {
	return runLambda(context, async () => {
		const logger = createLogger({
			source: "lambda",
			function: "backup-user-settings",
		});
		logger.info("Lambda invoke", {
			action: "lambda_invoke",
			eventId: event.id,
			eventTime: event.time,
		});

		try {
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
		} catch (err) {
			// Emit a structured level=error line so the shared-infra enricher surfaces
			// the cause in the alarm email and the aggregate ErrorLogCount counts it,
			// then rethrow so the AWS/Lambda Errors alarm also fires.
			logger.error("Backup failed", { action: "backup_failed" }, createErrorForLogging(err));
			throw err;
		}
	});
}
