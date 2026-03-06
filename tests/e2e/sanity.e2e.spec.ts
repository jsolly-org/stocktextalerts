import { createHmac, randomUUID } from "node:crypto";
import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { rootLogger } from "../../src/lib/logging";
import { getAssetData } from "../helpers/asset-data";
import { NEW_PASSWORD, TEST_PASSWORD } from "../helpers/constants";
import { adminClient } from "../helpers/test-env";
import {
	cleanupTestUser,
	createTestUser,
	generateUniquePhoneNumber,
} from "../helpers/test-user";

type InbucketListItem = {
	id: string;
	subject?: string;
};

type InbucketMessage = {
	subject?: string;
	body?: {
		text?: string;
		html?: string;
	};
};

type MailpitRecipient = {
	Address?: string;
};

type MailpitListResponse = {
	messages?: Array<{
		ID: string;
		Subject?: string;
		To?: MailpitRecipient[];
	}>;
};

type MailpitMessageResponse = {
	Subject?: string;
	Text?: string;
	HTML?: string;
};

function toBase64Url(buffer: Buffer): string {
	return buffer
		.toString("base64")
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/u, "");
}

function createEmailUnsubscribeToken(userId: string, email: string): string {
	const secret = process.env.CRON_SECRET;
	if (!secret) {
		throw new Error("CRON_SECRET is required to build unsubscribe token");
	}
	const expiresAtMs = Date.now() + 1000 * 60 * 60 * 24 * 30;
	const payload = `${userId}.${email}.${expiresAtMs}`;
	const signature = createHmac("sha256", secret).update(payload).digest();
	return `${expiresAtMs}.${toBase64Url(signature)}`;
}

function computeTwilioSignature(
	authToken: string,
	url: string,
	params: Record<string, string | undefined>,
): string {
	const sortedKeys = Object.keys(params)
		.filter((key) => params[key] != null)
		.sort();
	let data = url;
	for (const key of sortedKeys) {
		data += key + params[key];
	}
	return createHmac("sha1", authToken).update(data, "utf-8").digest("base64");
}

function buildInboundSignatureParams(
	params: Record<string, string>,
): Record<string, string | undefined> {
	const signatureParams: Record<string, string | undefined> = {
		MessageSid: undefined,
		SmsSid: undefined,
		SmsMessageSid: undefined,
		AccountSid: undefined,
		MessagingServiceSid: undefined,
		From: undefined,
		FromCity: undefined,
		FromState: undefined,
		FromZip: undefined,
		FromCountry: undefined,
		To: undefined,
		ToCity: undefined,
		ToState: undefined,
		ToZip: undefined,
		ToCountry: undefined,
		Body: undefined,
		NumSegments: undefined,
		NumMedia: undefined,
		ApiVersion: undefined,
		SmsStatus: undefined,
		ForwardedFrom: undefined,
		CallerName: undefined,
	};

	for (let index = 0; index < 10; index += 1) {
		signatureParams[`MediaUrl${index}`] = undefined;
		signatureParams[`MediaContentType${index}`] = undefined;
	}

	return { ...signatureParams, ...params };
}

function rewriteLinkOrigin(link: string, baseOrigin: string): string {
	const rewritten = new URL(link);
	const base = new URL(baseOrigin);
	rewritten.protocol = base.protocol;
	rewritten.host = base.host;
	return rewritten.toString();
}

function extractLinks(message: InbucketMessage): string[] {
	const html = message.body?.html ?? "";
	const text = message.body?.text ?? "";
	const raw = `${html}\n${text}`;
	const matches = raw.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
	const normalized = matches.map((match) => match.replaceAll("&amp;", "&"));
	return [...new Set(normalized)];
}

async function getInbucketMessages(email: string): Promise<InbucketListItem[]> {
	const localPart = email.split("@")[0];
	if (!localPart) {
		return [];
	}

	const mailboxResponse = await fetch(
		`http://localhost:54324/api/v1/mailbox/${encodeURIComponent(localPart)}`,
	);
	if (mailboxResponse.status === 404) {
		const mailpitResponse = await fetch(
			"http://localhost:54324/api/v1/messages",
		);
		if (!mailpitResponse.ok) {
			const body = await mailpitResponse.text();
			throw new Error(
				`Failed to read Mailpit messages: ${mailpitResponse.status} ${body}`,
			);
		}
		const payload = (await mailpitResponse.json()) as MailpitListResponse;
		return (payload.messages ?? [])
			.filter((message) =>
				(message.To ?? []).some(
					(recipient) =>
						recipient.Address?.toLowerCase() === email.toLowerCase(),
				),
			)
			.map((message) => ({
				id: message.ID,
				subject: message.Subject,
			}));
	}
	if (!mailboxResponse.ok) {
		const body = await mailboxResponse.text();
		throw new Error(
			`Failed to read Inbucket mailbox: ${mailboxResponse.status} ${body}`,
		);
	}

	return (await mailboxResponse.json()) as InbucketListItem[];
}

async function getInbucketMessage(
	email: string,
	messageId: string,
): Promise<InbucketMessage> {
	const localPart = email.split("@")[0];
	if (!localPart) {
		throw new Error("Invalid email local-part");
	}

	const response = await fetch(
		`http://localhost:54324/api/v1/mailbox/${encodeURIComponent(localPart)}/${encodeURIComponent(messageId)}`,
	);
	if (response.status === 404) {
		const mailpitResponse = await fetch(
			`http://localhost:54324/api/v1/message/${encodeURIComponent(messageId)}`,
		);
		if (!mailpitResponse.ok) {
			const body = await mailpitResponse.text();
			throw new Error(
				`Failed to fetch Mailpit message: ${mailpitResponse.status} ${body}`,
			);
		}
		const payload = (await mailpitResponse.json()) as MailpitMessageResponse;
		return {
			subject: payload.Subject,
			body: {
				text: payload.Text,
				html: payload.HTML,
			},
		};
	}
	if (!response.ok) {
		const body = await response.text();
		throw new Error(
			`Failed to fetch Inbucket message: ${response.status} ${body}`,
		);
	}

	return (await response.json()) as InbucketMessage;
}

async function waitForEmail(
	email: string,
	subjectContains: string,
	timeoutMs = 30_000,
): Promise<InbucketMessage> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		const messages = await getInbucketMessages(email);
		const match = messages.find((message) =>
			(message.subject ?? "").includes(subjectContains),
		);
		if (match?.id) {
			return getInbucketMessage(email, match.id);
		}

		await new Promise((resolve) => setTimeout(resolve, 1000));
	}

	throw new Error(
		`Timed out waiting for email "${subjectContains}" for ${email} after ${timeoutMs}ms`,
	);
}

async function maybeWaitForEmail(
	email: string,
	subjectContains: string,
	timeoutMs = 30_000,
): Promise<InbucketMessage | null> {
	try {
		return await waitForEmail(email, subjectContains, timeoutMs);
	} catch {
		return null;
	}
}

async function expectCurrentPath(
	page: Page,
	expectedPath: string,
	timeout = 15_000,
) {
	await expect
		.poll(() => new URL(page.url()).pathname, {
			message: `Expected path ${expectedPath}`,
			timeout,
		})
		.toBe(expectedPath);
}

async function signIn(page: Page, email: string, password: string) {
	await page.goto("/auth/signin");
	const emailInput = page.locator("#email");
	// Poll-fill email until Vue hydration finishes and stops clearing the value
	await expect
		.poll(
			async () => {
				await emailInput.fill(email);
				return emailInput.inputValue();
			},
			{ timeout: 10_000, message: "Email value cleared by hydration" },
		)
		.toBe(email);
	await page.locator("#password").fill(password);
	await page.getByRole("button", { name: "Sign In" }).click();
	await expectCurrentPath(page, "/dashboard");
}

async function addAsset(page: Page, symbol: string) {
	const input = page.locator("#asset_search");
	await Promise.all([
		page.waitForResponse(
			(response) =>
				response.url().includes("/api/assets/search") &&
				response.status() === 200,
			{
				timeout: 15_000,
			},
		),
		input.fill(symbol),
	]);
	await input.press("ArrowDown");
	await input.press("Enter");
	await expect(
		page.getByRole("button", { name: `Remove ${symbol}` }),
	).toBeVisible({
		timeout: 15_000,
	});
}

async function ensureAssetsExist(symbols: string[]): Promise<void> {
	const uniqueSymbols = [...new Set(symbols)];
	const assetRecords = uniqueSymbols.map((symbol) => {
		const assetData = getAssetData(symbol);
		return {
			symbol: assetData.symbol,
			name: assetData.name,
			type: assetData.type,
		};
	});
	const { error } = await adminClient
		.from("assets")
		.upsert(assetRecords, { onConflict: "symbol" });
	if (error) {
		throw new Error(`Failed to ensure assets exist: ${error.message}`);
	}
}

async function fetchNextSendAt(userId: string): Promise<string | null> {
	const { data, error } = await adminClient
		.from("users")
		.select("market_scheduled_asset_price_next_send_at")
		.eq("id", userId)
		.single();
	if (error) {
		throw new Error(`Failed to read next_send_at: ${error.message}`);
	}
	return data.market_scheduled_asset_price_next_send_at;
}

async function waitForNextSendAdvance(
	userId: string,
	previousValue: string | null,
	timeoutMs = 120_000,
): Promise<string> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		const currentValue = await fetchNextSendAt(userId);
		if (currentValue && currentValue !== previousValue) {
			return currentValue;
		}
		await new Promise((resolve) => setTimeout(resolve, 2000));
	}

	throw new Error(
		`Timed out waiting for market_scheduled_asset_price_next_send_at to advance from ${String(previousValue)}`,
	);
}

async function waitForTrackedAssets(
	userId: string,
	expectedSymbols: string[],
	timeoutMs = 30_000,
): Promise<void> {
	const expected = [...expectedSymbols].sort();
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		const { data, error } = await adminClient
			.from("user_assets")
			.select("symbol")
			.eq("user_id", userId)
			.order("symbol");
		if (error) {
			throw new Error(`Failed to read tracked assets: ${error.message}`);
		}
		const symbols = (data ?? []).map((row) => row.symbol).sort();
		if (
			symbols.length === expected.length &&
			symbols.every((value, idx) => value === expected[idx])
		) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}

	throw new Error(
		`Timed out waiting for tracked assets to become [${expected.join(", ")}]`,
	);
}

async function waitForEmailNotificationsEnabled(
	userId: string,
	expectedValue: boolean,
	timeoutMs = 30_000,
): Promise<void> {
	await expect
		.poll(
			async () => {
				const { data, error } = await adminClient
					.from("users")
					.select("email_notifications_enabled")
					.eq("id", userId)
					.single();
				if (error) {
					throw new Error(
						`Failed to read email notification state: ${error.message}`,
					);
				}
				return data.email_notifications_enabled;
			},
			{
				timeout: timeoutMs,
			},
		)
		.toBe(expectedValue);
}

test.describe("sanity tests", () => {
	test.describe.configure({ mode: "serial" });

	let context: BrowserContext;
	let page: Page;
	let baseOrigin = "";

	let testEmail = "";
	const testPassword = TEST_PASSWORD;
	const newPassword = NEW_PASSWORD;
	let secondEmail = "";
	let testUserId: string | null = null;

	let inboundUserId: string | null = null;
	let inboundUserPhone = "";

	async function triggerSchedule(force = true) {
		const cronSecret = process.env.CRON_SECRET;
		if (!cronSecret) {
			throw new Error("CRON_SECRET is required to trigger /api/schedule");
		}
		const response = await fetch(`${baseOrigin}/api/schedule`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${cronSecret}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ force }),
		});
		if (!response.ok) {
			const body = await response.text();
			throw new Error(`Schedule trigger failed: ${response.status} ${body}`);
		}
	}

	test.beforeAll(async ({ browser }) => {
		context = await browser.newContext();
		page = await context.newPage();
		await page.goto("/");
		baseOrigin = new URL(page.url()).origin;
	});

	test.afterAll(async () => {
		if (testUserId) {
			try {
				await cleanupTestUser(testUserId);
			} catch (error) {
				rootLogger.warn("Failed to cleanup primary sanity test user", {
					error,
				});
			}
		}
		if (inboundUserId) {
			try {
				await cleanupTestUser(inboundUserId);
			} catch (error) {
				rootLogger.warn("Failed to cleanup inbound sanity test user", {
					error,
				});
			}
		}
		if (page) {
			await page.close();
		}
		if (context) {
			await context.close();
		}
	});

	test("TC-REG-001: User can register for a new account", async () => {
		test.slow();
		test.setTimeout(120_000);

		testEmail = `sanity-${randomUUID()}@resend.dev`;
		secondEmail = `sanity-second-${randomUUID()}@resend.dev`;

		await page.goto("/auth/register");
		await page.locator("#email").fill(testEmail);
		await page.locator("#password").fill(testPassword);
		await page.locator("#confirm").fill(testPassword);
		await page.getByRole("button", { name: "Create account" }).click();
		await expectCurrentPath(page, "/auth/unconfirmed");

		const confirmationEmail = await waitForEmail(
			testEmail,
			"Confirm your email",
			60_000,
		);
		const confirmationLink = extractLinks(confirmationEmail).find(
			(link) => link.includes("token_hash=") && link.includes("type=email"),
		);
		expect(confirmationLink).toBeTruthy();
		if (!confirmationLink) {
			throw new Error("Confirmation email link not found");
		}

		await page.goto(rewriteLinkOrigin(confirmationLink, baseOrigin));
		await expectCurrentPath(page, "/auth/verified");
		await page.getByRole("button", { name: "Verify my email" }).click();
		await expect(page.getByText("Email Verified!")).toBeVisible();

		await signIn(page, testEmail, testPassword);

		const { data, error } = await adminClient
			.from("users")
			.select("id")
			.eq("email", testEmail)
			.maybeSingle();
		if (error) {
			throw new Error(`Failed to resolve registered user: ${error.message}`);
		}
		expect(data?.id).toBeTruthy();
		testUserId = data?.id ?? null;
	});

	test("TC-AUTH-001: User can sign out and sign back in", async () => {
		await page.getByRole("button", { name: "Sign Out" }).click();
		await expectCurrentPath(page, "/");

		await page.goto("/dashboard");
		await expectCurrentPath(page, "/auth/signin");

		await signIn(page, testEmail, testPassword);
	});

	test("TC-DASH-001: New user dashboard has correct initial state", async () => {
		await page.goto("/dashboard");
		await expectCurrentPath(page, "/dashboard");

		// Email toggle should be ON by default
		const emailSwitch = page.getByRole("switch", {
			name: "Email notifications",
		});
		await expect(emailSwitch).toHaveAttribute("aria-checked", "true");

		// SMS toggle should be OFF by default
		const smsSwitch = page.getByRole("switch", {
			name: "SMS notifications",
		});
		await expect(smsSwitch).toHaveAttribute("aria-checked", "false");

		// Phone input should NOT be visible when SMS is off
		await expect(page.locator("#phone")).not.toBeVisible();

		// No tracked assets
		await expect(page.getByText("No assets tracked yet")).toBeVisible();
	});

	test("TC-TZ-001: User can configure timezone", async () => {
		await page.goto("/profile");
		await expectCurrentPath(page, "/profile");

		// Wait for the TimezoneSection Vue component to hydrate (client:idle).
		await page.locator("[data-hydrated]").waitFor({ timeout: 15_000 });

		const timezoneSelect = page.locator("#profile-timezone");
		const currentTimezone = await timezoneSelect.inputValue();
		const targetTimezone =
			currentTimezone === "America/Chicago"
				? "America/New_York"
				: "America/Chicago";

		await Promise.all([
			page.waitForResponse(
				(response) =>
					response.url().includes("/api/notification-preferences/timezone") &&
					response.status() === 200,
				{ timeout: 15_000 },
			),
			timezoneSelect.selectOption(targetTimezone),
		]);
		await expect(page.getByText("Timezone updated.")).toBeVisible({
			timeout: 10_000,
		});
		await expect(timezoneSelect).toHaveValue(targetTimezone);

		await page.reload();
		await expectCurrentPath(page, "/profile");
		await expect(page.locator("#profile-timezone")).toHaveValue(targetTimezone);
	});

	test("TC-TIME-001: User can toggle 24-hour time format", async () => {
		await page.goto("/profile");
		await expectCurrentPath(page, "/profile");

		// Wait for the TimeFormatSection Vue component to hydrate.
		await page.locator("[data-hydrated]").waitFor({ timeout: 15_000 });

		const timeSwitch = page.getByRole("switch", {
			name: "Use 24-hour time",
		});

		// Default should be OFF (12-hour)
		await expect(timeSwitch).toHaveAttribute("aria-checked", "false");

		// Toggle ON and verify save confirmation
		await Promise.all([
			page.waitForResponse(
				(response) =>
					response.url().includes("/api/profile/time-format") &&
					response.status() === 200,
				{ timeout: 15_000 },
			),
			timeSwitch.click(),
		]);
		await expect(timeSwitch).toHaveAttribute("aria-checked", "true");
		await expect(page.getByText("Time format updated.")).toBeVisible({
			timeout: 10_000,
		});

		// Reload and verify it persisted
		await page.reload();
		await page.locator("[data-hydrated]").waitFor({ timeout: 15_000 });
		await expect(
			page.getByRole("switch", { name: "Use 24-hour time" }),
		).toHaveAttribute("aria-checked", "true");

		// Toggle back OFF so we don't affect other tests
		const timeSwitchAfterReload = page.getByRole("switch", {
			name: "Use 24-hour time",
		});
		await Promise.all([
			page.waitForResponse(
				(response) =>
					response.url().includes("/api/profile/time-format") &&
					response.status() === 200,
				{ timeout: 15_000 },
			),
			timeSwitchAfterReload.click(),
		]);
		await expect(timeSwitchAfterReload).toHaveAttribute(
			"aria-checked",
			"false",
		);
	});

	test("TC-AST-001: User can add assets to track", async () => {
		if (!testUserId) {
			throw new Error("testUserId not set before TC-AST-001");
		}

		await ensureAssetsExist(["AAPL", "MSFT", "GOOGL"]);

		await page.goto("/dashboard");
		await expectCurrentPath(page, "/dashboard");

		await addAsset(page, "AAPL");
		await addAsset(page, "MSFT");
		await addAsset(page, "GOOGL");
		await waitForTrackedAssets(testUserId, ["AAPL", "GOOGL", "MSFT"]);

		await page.reload();
		await expect(
			page.getByRole("button", { name: "Remove AAPL" }),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Remove MSFT" }),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Remove GOOGL" }),
		).toBeVisible();
	});

	test("TC-BADGE-001: Asset badges show logo, Stock, or ETF", async () => {
		if (!testUserId) {
			throw new Error("testUserId not set before TC-BADGE-001");
		}

		const assertNoDbError = (
			error: { message: string } | null,
			action: string,
		) => {
			if (error) throw new Error(`${action}: ${error.message}`);
		};

		const msftIconUrl =
			"https://api.massive.com/v1/reference/company-branding/d3d3Lm1pY3Jvc29mdC5jb20/images/2022-01-10_icon.png";

		try {
			const { error: aaplErr } = await adminClient
				.from("assets")
				.update({ icon_url: null })
				.eq("symbol", "AAPL");
			assertNoDbError(aaplErr, "Failed to clear AAPL icon_url");

			const { error: msftErr } = await adminClient
				.from("assets")
				.update({ icon_url: msftIconUrl })
				.eq("symbol", "MSFT");
			assertNoDbError(msftErr, "Failed to set MSFT icon_url");

			const { error: googlErr } = await adminClient
				.from("assets")
				.update({ icon_url: "https://invalid.test/broken-icon.png" })
				.eq("symbol", "GOOGL");
			assertNoDbError(googlErr, "Failed to set GOOGL icon_url");

			await ensureAssetsExist(["VOO"]);
			await page.goto("/dashboard");
			await expectCurrentPath(page, "/dashboard");
			await addAsset(page, "VOO");
			await waitForTrackedAssets(testUserId, ["AAPL", "GOOGL", "MSFT", "VOO"]);

			await page.reload();

			const getRow = (symbol: string) =>
				page
					.getByRole("button", { name: `Remove ${symbol}` })
					.locator("xpath=ancestor::li");

			// MSFT has an icon_url but the logo proxy may fail in CI (dummy API key),
			// so accept either the logo image or the "Stock" fallback badge.
			await expect(
				getRow("MSFT")
					.locator(`img[alt="MSFT logo"]`)
					.or(getRow("MSFT").getByText("Stock")),
			).toBeVisible({ timeout: 15_000 });

			await expect(getRow("AAPL").getByText("Stock")).toBeVisible();

			await expect(getRow("GOOGL").getByText("Stock")).toBeVisible({
				timeout: 15_000,
			});

			await expect(
				getRow("VOO").getByText("ETF", { exact: true }),
			).toBeVisible();

			await ensureAssetsExist(["NVDA"]);
			const { error: nvdaErr } = await adminClient
				.from("assets")
				.update({ icon_url: msftIconUrl })
				.eq("symbol", "NVDA");
			assertNoDbError(nvdaErr, "Failed to set NVDA icon_url");

			const input = page.locator("#asset_search");
			await Promise.all([
				page.waitForResponse(
					(response) =>
						response.url().includes("/api/assets/search") &&
						response.status() === 200,
					{ timeout: 15_000 },
				),
				input.fill("NVDA"),
			]);

			const dropdown = page.locator("#asset_dropdown");
			const nvdaOption = dropdown
				.getByRole("option")
				.filter({ hasText: "NVDA - NVIDIA" });
			await expect(nvdaOption).toBeVisible({ timeout: 15_000 });
			// Logo proxy may fail in CI (dummy API key), so accept logo or "Stock" fallback.
			await expect(
				nvdaOption
					.locator(`img[alt="NVDA logo"]`)
					.or(nvdaOption.getByText("Stock")),
			).toBeVisible();

			await input.fill("");
		} finally {
			await page
				.getByRole("button", { name: "Remove VOO" })
				.click()
				.catch(() => {});
			await waitForTrackedAssets(testUserId, ["AAPL", "GOOGL", "MSFT"]).catch(
				() => {},
			);
			await adminClient
				.from("assets")
				.update({ icon_url: null })
				.eq("symbol", "AAPL");
			await adminClient
				.from("assets")
				.update({ icon_url: null })
				.eq("symbol", "MSFT");
			await adminClient
				.from("assets")
				.update({ icon_url: null })
				.eq("symbol", "GOOGL");
			await adminClient
				.from("assets")
				.update({ icon_url: null })
				.eq("symbol", "NVDA");
		}
	});

	test("TC-EMAIL-001: User can enable email notifications and receive an update", async () => {
		test.slow();
		test.setTimeout(180_000);
		if (!testUserId) {
			throw new Error("testUserId not set before TC-EMAIL-001");
		}

		await page.goto("/dashboard");
		const emailSwitch = page.getByRole("switch", {
			name: "Email notifications",
		});
		if ((await emailSwitch.getAttribute("aria-checked")) !== "true") {
			await emailSwitch.click();
		}

		const marketNotificationsForm = page.locator(
			'form[aria-label="Market notifications"]',
		);
		const scheduledEmailCheckbox = marketNotificationsForm
			.getByRole("checkbox", { name: "Email" })
			.nth(1);
		if (!(await scheduledEmailCheckbox.isChecked())) {
			await scheduledEmailCheckbox.click();
		}

		const marketOpenButton = marketNotificationsForm.getByRole("button", {
			name: /Set delivery time to after US market open/i,
		});
		if (await marketOpenButton.isVisible()) {
			await marketOpenButton.click();
		}

		await expect
			.poll(
				async () => {
					const { data, error } = await adminClient
						.from("users")
						.select(
							"email_notifications_enabled,market_scheduled_asset_price_include_email,market_scheduled_asset_price_times",
						)
						.eq("id", testUserId)
						.single();
					if (error) {
						throw new Error(
							`Failed to verify email notification preferences: ${error.message}`,
						);
					}
					return (
						data.email_notifications_enabled === true &&
						data.market_scheduled_asset_price_include_email === true &&
						Array.isArray(data.market_scheduled_asset_price_times) &&
						data.market_scheduled_asset_price_times.length > 0
					);
				},
				{ timeout: 30_000 },
			)
			.toBe(true);

		await page.reload();
		await expect(emailSwitch).toHaveAttribute("aria-checked", "true");
		await expect(scheduledEmailCheckbox).toBeChecked();

		const { error: resetEmailNextSendError } = await adminClient
			.from("users")
			.update({ market_scheduled_asset_price_next_send_at: null })
			.eq("id", testUserId);
		if (resetEmailNextSendError) {
			throw new Error(
				`Failed to reset email next_send_at: ${resetEmailNextSendError.message}`,
			);
		}

		const previousNextSendAt = await fetchNextSendAt(testUserId);
		await triggerSchedule(true);
		await waitForNextSendAdvance(testUserId, previousNextSendAt, 120_000);
	});

	test("TC-NOTIF-001: Notification preferences persist on reload", async () => {
		if (!testUserId) {
			throw new Error("testUserId not set before TC-NOTIF-001");
		}

		await page.goto("/dashboard");

		const emailSwitch = page.getByRole("switch", {
			name: "Email notifications",
		});

		// Email should be ON from TC-EMAIL-001 — toggle it OFF
		await expect(emailSwitch).toHaveAttribute("aria-checked", "true");
		await emailSwitch.click();
		await waitForEmailNotificationsEnabled(testUserId, false);

		// Full navigation to verify OFF persisted in UI
		await page.goto("/dashboard");
		await expect(emailSwitch).toHaveAttribute("aria-checked", "false");

		// Restore email ON via admin client for subsequent tests
		// (avoids intermittent auto-save issues with a second toggle after navigation)
		await adminClient
			.from("users")
			.update({ email_notifications_enabled: true })
			.eq("id", testUserId);
	});

	test("TC-UNSUB-001: User can unsubscribe via email link", async () => {
		if (!testUserId) {
			throw new Error("testUserId not set before TC-UNSUB-001");
		}

		const token = createEmailUnsubscribeToken(testUserId, testEmail);
		const unsubscribeUrl = `${baseOrigin}/email/unsubscribe?user=${encodeURIComponent(testUserId)}&token=${encodeURIComponent(token)}`;
		await page.goto(unsubscribeUrl);
		await expect(
			page.getByText("Email notifications are now turned off."),
		).toBeVisible();

		await page.goto("/dashboard");
		const emailSwitch = page.getByRole("switch", {
			name: "Email notifications",
		});
		await waitForEmailNotificationsEnabled(testUserId, false);
		await expect(emailSwitch).toHaveAttribute("aria-checked", "false");

		// Restore email ON via admin client for subsequent tests
		await adminClient
			.from("users")
			.update({ email_notifications_enabled: true })
			.eq("id", testUserId);
	});

	test("TC-AUTH-002: Dashboard state persists across sign-out and sign-in", async () => {
		await page.goto("/dashboard");

		// Verify tracked assets still present
		await expect(
			page.getByRole("button", { name: "Remove AAPL" }),
		).toBeVisible();

		// Verify email toggle is ON (re-enabled in TC-NOTIF-001)
		const emailSwitch = page.getByRole("switch", {
			name: "Email notifications",
		});
		await expect(emailSwitch).toHaveAttribute("aria-checked", "true");

		// Sign out
		await page.getByRole("button", { name: "Sign Out" }).click();
		await expectCurrentPath(page, "/");

		// Dashboard should redirect to sign-in
		await page.goto("/dashboard");
		await expectCurrentPath(page, "/auth/signin");

		// Sign back in
		await signIn(page, testEmail, testPassword);

		// Verify state persisted
		await expect(
			page.getByRole("button", { name: "Remove AAPL" }),
		).toBeVisible();
		await expect(
			page.getByRole("switch", { name: "Email notifications" }),
		).toHaveAttribute("aria-checked", "true");
	});

	test("TC-PROF-001: User can change password and update email", async () => {
		test.slow();
		test.setTimeout(180_000);

		if (!testUserId) {
			throw new Error("testUserId not set before TC-PROF-001");
		}

		await page.goto("/profile");
		await page.locator("#new-password").fill(newPassword);
		await page.locator("#confirm-password").fill(newPassword);
		await page.getByRole("button", { name: "Update password" }).click();
		await expectCurrentPath(page, "/profile");
		await expect(
			page.getByText("Password updated successfully!"),
		).toBeVisible();

		await page.getByRole("button", { name: "Sign Out" }).click();
		await expectCurrentPath(page, "/");
		await signIn(page, testEmail, newPassword);

		await page.goto("/profile");
		await page.locator("#new-email").fill(secondEmail);
		await page.getByRole("button", { name: "Update email" }).click();
		await expectCurrentPath(page, "/profile");
		await expect(
			page.getByText(
				"Check your old and new inboxes to confirm the email change.",
			),
		).toBeVisible();

		const [newEmailMessage, oldEmailMessage] = await Promise.all([
			waitForEmail(secondEmail, "email change", 30_000),
			maybeWaitForEmail(testEmail, "email change", 15_000),
		]);

		const candidateLinks = [
			...extractLinks(newEmailMessage),
			...(oldEmailMessage ? extractLinks(oldEmailMessage) : []),
		];
		const emailChangeLinks = [...new Set(candidateLinks)].filter(
			(link) =>
				link.includes("token_hash=") && link.includes("type=email_change"),
		);
		expect(emailChangeLinks.length).toBeGreaterThan(0);

		for (const link of emailChangeLinks) {
			await page.goto(rewriteLinkOrigin(link, baseOrigin));
			// The verified page renders a confirmation form — click to consume the OTP token
			await page.getByRole("button", { name: "Verify my email" }).click();
		}

		// After both confirmations (double_confirm_changes), the last redirect goes
		// to /auth/signin — sign in with the new email
		await signIn(page, secondEmail, newPassword);

		const { data, error } = await adminClient
			.from("users")
			.select("email")
			.eq("id", testUserId)
			.single();
		if (error) {
			throw new Error(`Failed to validate updated email: ${error.message}`);
		}
		expect(data.email).toBe(secondEmail);
		testEmail = secondEmail;
	});

	test("TC-DEL-001: User can delete their account", async () => {
		await page.goto("/profile");
		page.once("dialog", async (dialog) => {
			await dialog.accept();
		});
		await page.getByRole("button", { name: "Delete Account" }).click();
		await expectCurrentPath(page, "/");

		await page.goto("/dashboard");
		await expectCurrentPath(page, "/auth/signin");
		testUserId = null;
	});

	test("TC-INBOUND-001: Inbound SMS keywords", async () => {
		const inboundUser = await createTestUser({
			email: `inbound-${randomUUID()}@resend.dev`,
			password: TEST_PASSWORD,
			confirmed: true,
			smsNotificationsEnabled: true,
			phoneCountryCode: "+1",
			phoneNumber: generateUniquePhoneNumber(),
			phoneVerified: true,
			marketScheduledAssetPriceIncludeSms: true,
		});
		inboundUserId = inboundUser.id;
		inboundUserPhone = await (async () => {
			const { data, error } = await adminClient
				.from("users")
				.select("phone_country_code,phone_number")
				.eq("id", inboundUser.id)
				.single();
			if (error) {
				throw new Error(`Failed to read inbound user phone: ${error.message}`);
			}
			return `${data.phone_country_code}${data.phone_number}`;
		})();

		const authToken = process.env.TWILIO_AUTH_TOKEN;
		if (!authToken) {
			throw new Error("TWILIO_AUTH_TOKEN is required for inbound signature");
		}

		const webhookUrl = `${baseOrigin}/api/messaging/inbound`;
		async function postInbound(bodyValue: string) {
			const formParams = {
				MessageSid: `SM${randomUUID().replaceAll("-", "").slice(0, 16)}`,
				AccountSid: "AC1234567890",
				From: inboundUserPhone,
				To: "+15551234567",
				Body: bodyValue,
			};
			const signatureParams = buildInboundSignatureParams(formParams);
			const signature = computeTwilioSignature(
				authToken,
				webhookUrl,
				signatureParams,
			);
			const body = new URLSearchParams(formParams);
			return fetch(webhookUrl, {
				method: "POST",
				headers: {
					"x-twilio-signature": signature,
					"content-type": "application/x-www-form-urlencoded",
				},
				body: body.toString(),
			});
		}

		const helpResponse = await postInbound("HELP");
		expect(helpResponse.status).toBe(200);
		await expect(helpResponse.text()).resolves.toContain("Reply STOP");

		const stopResponse = await postInbound("STOP");
		expect(stopResponse.status).toBe(200);

		const { data: afterStop, error: stopError } = await adminClient
			.from("users")
			.select("sms_opted_out,sms_notifications_enabled")
			.eq("id", inboundUser.id)
			.single();
		if (stopError) {
			throw new Error(`Failed to validate STOP state: ${stopError.message}`);
		}
		expect(afterStop.sms_opted_out).toBe(true);
		expect(afterStop.sms_notifications_enabled).toBe(false);

		const startResponse = await postInbound("START");
		expect(startResponse.status).toBe(200);

		const { data: afterStart, error: startError } = await adminClient
			.from("users")
			.select("sms_opted_out,sms_notifications_enabled")
			.eq("id", inboundUser.id)
			.single();
		if (startError) {
			throw new Error(`Failed to validate START state: ${startError.message}`);
		}
		expect(afterStart.sms_opted_out).toBe(false);
		expect(afterStart.sms_notifications_enabled).toBe(false);
	});
});
