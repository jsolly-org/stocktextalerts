import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";

export type AlertSeverity = "error" | "warn" | "info";

export type LambdaContext = {
	functionName: string;
	logGroupName: string;
	logStreamName: string;
	awsRequestId: string;
	invokedFunctionArn: string;
};

let snsClient: SNSClient | undefined;

function getClient(): SNSClient {
	if (!snsClient) {
		snsClient = new SNSClient({});
	}
	return snsClient;
}

function extractAccountId(arn: string): string {
	// arn:aws:lambda:us-east-1:730335616323:function:Name
	return arn.split(":")[4] ?? "unknown";
}

function extractRegion(arn: string): string {
	return arn.split(":")[3] ?? "us-east-1";
}

function formatBody(
	ctx: LambdaContext,
	severity: AlertSeverity,
	title: string,
	message: string,
	details?: Record<string, unknown>,
): string {
	const region = extractRegion(ctx.invokedFunctionArn);
	const accountId = extractAccountId(ctx.invokedFunctionArn);
	const lines = [
		`[${severity.toUpperCase()}] stocktextalerts — ${title}`,
		"",
		message,
		"",
		`Function:   ${ctx.functionName}`,
		`Log Group:  ${ctx.logGroupName}`,
		`Request ID: ${ctx.awsRequestId}`,
		`Region:     ${region}`,
		`Account:    ${accountId}`,
		`Git SHA:    ${process.env.GIT_SHA ?? "unknown"}`,
		`Time:       ${new Date().toISOString()}`,
	];

	if (details && Object.keys(details).length > 0) {
		lines.push("", "Details:");
		for (const [key, value] of Object.entries(details)) {
			lines.push(
				`  ${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
			);
		}
	}

	return lines.join("\n");
}

export function publishAlert(
	ctx: LambdaContext,
	severity: AlertSeverity,
	title: string,
	message: string,
	details?: Record<string, unknown>,
): void {
	const topicArn = process.env.ALERT_TOPIC_ARN;
	if (!topicArn) {
		// Running outside Lambda (local dev, Vercel) — skip silently.
		return;
	}

	const subject = `[${severity.toUpperCase()}] stocktextalerts: ${title}`.slice(
		0,
		100,
	);
	const body = formatBody(ctx, severity, title, message, details);

	// Fire-and-forget — never let alert publishing fail the handler.
	getClient()
		.send(
			new PublishCommand({
				TopicArn: topicArn,
				Subject: subject,
				Message: body,
			}),
		)
		.catch((err) => {
			// Fire-and-forget — never crash the handler. CloudWatch Logs is the fallback.
			console.warn("SNS alert publish failed", err);
		});
}
