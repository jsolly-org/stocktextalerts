import { createHmac, randomUUID } from "node:crypto";
import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
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
	params: Record<string, string>,
): string {
	const sortedKeys = Object.keys(params).sort();
	let data = url;
	for (const key of sortedKeys) {
		data += key + params[key];
	}
	return createHmac("sha1", authToken).update(data, "utf-8").digest("base64");
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

	const response = await fetch(
		`http://localhost:54324/api/v1/mailbox/${encodeURIComponent(localPart)}`,
	);
	if (response.status === 404) {
		return [];
	}
	if (!response.ok) {
		const body = await response.text();
		throw new Error(`Failed to read Inbucket mailbox: ${response.status} ${body}`);
	}

	return (await response.json()) as InbucketListItem[];
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
	if (!response.ok) {
		const body = await response.text();
		throw new Error(`Failed to fetch Inbucket message: ${response.status} ${body}`);
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

async function expectCurrentPath(page: Page, expectedPath: string) {
	await expect
		.poll(() => new URL(page.url()).pathname, {
			message: `Expected path ${expectedPath}`,
		})
		.toBe(expectedPath);
}

async function signIn(page: Page, email: string, password: string) {
	await page.goto("/auth/signin");
	await page.locator("#email").fill(email);
	await page.locator("#password").fill(password);
	await page.getByRole("button", { name: "Sign In" }).click();
	await expectCurrentPath(page, "/dashboard");
}

async function addAsset(page: Page, symbol: string) {
	const input = page.locator("#asset_search");
	await input.fill(symbol);
	const option = page
		.locator('#asset_dropdown [role="option"]')
		.filter({ hasText: new RegExp(`^${symbol}\\b`) })
		.first();
	await expect(option).toBeVisible();
	await option.click();
	await expect(page.getByRole("button", { name: `Remove ${symbol}` })).toBeVisible();
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
				console.warn("Failed to cleanup primary sanity test user", error);
			}
		}
		if (inboundUserId) {
			try {
				await cleanupTestUser(inboundUserId);
			} catch (error) {
				console.warn("Failed to cleanup inbound sanity test user", error);
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
		testEmail = `sanity-${randomUUID()}@resend.dev`;
		secondEmail = `sanity-second-${randomUUID()}@resend.dev`;

		await page.goto("/auth/register");
		await page.locator("#email").fill(testEmail);
		await page.locator("#password").fill(testPassword);
		await page.getByRole("button", { name: "Register" }).click();
		await expectCurrentPath(page, "/auth/unconfirmed");

		const confirmationEmail = await waitForEmail(testEmail, "Confirm your email", 60_000);
		const confirmationLink = extractLinks(confirmationEmail).find(
			(link) => link.includes("token_hash=") && link.includes("type=email"),
		);
		expect(confirmationLink).toBeTruthy();
		if (!confirmationLink) {
			throw new Error("Confirmation email link not found");
		}

		await page.goto(rewriteLinkOrigin(confirmationLink, baseOrigin));
		await expectCurrentPath(page, "/auth/verified");

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

		await page.locator("#email").fill(testEmail);
		await page.locator("#password").fill(testPassword);
		await page.getByRole("button", { name: "Sign In" }).click();
		await expectCurrentPath(page, "/dashboard");
	});

	test("TC-TZ-001: User can configure timezone", async () => {
		await page.goto("/profile");
		await expectCurrentPath(page, "/profile");

		await page.locator("#profile-timezone").selectOption("America/Chicago");
		await expect(page.getByText("Timezone updated.")).toBeVisible();

		await page.reload();
		await expectCurrentPath(page, "/profile");
		await expect(page.locator("#profile-timezone")).toHaveValue("America/Chicago");
	});

	test("TC-AST-001: User can add assets to track", async () => {
		await page.goto("/dashboard");
		await expectCurrentPath(page, "/dashboard");

		await addAsset(page, "AAPL");
		await addAsset(page, "MSFT");
		await addAsset(page, "GOOGL");

		await page.reload();
		await expect(page.getByRole("button", { name: "Remove AAPL" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Remove MSFT" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Remove GOOGL" })).toBeVisible();
	});

	test("TC-EMAIL-001: User can enable email notifications and receive an update", async () => {
		test.slow();
		test.setTimeout(120_000);
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

		const scheduledCard = page
			.locator("section.card")
			.filter({
				has: page.getByRole("heading", {
					name: "Scheduled Asset Price Notifications",
				}),
			})
			.first();
		const scheduledEmailCheckbox = scheduledCard
			.locator('label:has-text("Email") input[type="checkbox"]')
			.first();
		if (!(await scheduledEmailCheckbox.isChecked())) {
			await scheduledEmailCheckbox.click();
		}

		const targetTime = new Date(Date.now() + 2 * 60_000)
			.toTimeString()
			.slice(0, 5);
		const initialTimeInput = scheduledCard.locator(
			"input#scheduled_update_time_initial",
		);
		const firstTimeInput = scheduledCard.locator("input#scheduled_update_time_0");
		if (await initialTimeInput.isVisible()) {
			await initialTimeInput.fill(targetTime);
		} else {
			await firstTimeInput.fill(targetTime);
		}

		await page.reload();
		await expect(emailSwitch).toHaveAttribute("aria-checked", "true");
		await expect(scheduledEmailCheckbox).toBeChecked();

		const previousNextSendAt = await fetchNextSendAt(testUserId);
		await triggerSchedule(true);
		await waitForNextSendAdvance(testUserId, previousNextSendAt, 120_000);
	});

	test("TC-SMS-001: User can enable SMS notifications and receive an update", async () => {
		test.slow();
		test.setTimeout(120_000);
		if (!testUserId) {
			throw new Error("testUserId not set before TC-SMS-001");
		}

		await page.goto("/dashboard");
		const localPhone = generateUniquePhoneNumber();
		if (await page.locator("#phone").isVisible()) {
			await page.locator("#phone").fill(localPhone);
		}

		const adminPhone = generateUniquePhoneNumber();
		const { error: updateError } = await adminClient
			.from("users")
			.update({
				phone_country_code: "+1",
				phone_number: adminPhone,
				phone_verified: true,
				sms_notifications_enabled: true,
				sms_opted_out: false,
				market_scheduled_asset_price_include_sms: true,
			})
			.eq("id", testUserId);
		if (updateError) {
			throw new Error(`Failed to enable SMS in admin update: ${updateError.message}`);
		}

		await page.reload();
		const smsSwitch = page.getByRole("switch", { name: "SMS notifications" });
		await expect(smsSwitch).toHaveAttribute("aria-checked", "true");

		const scheduledCard = page
			.locator("section.card")
			.filter({
				has: page.getByRole("heading", {
					name: "Scheduled Asset Price Notifications",
				}),
			})
			.first();
		const scheduledSmsCheckbox = scheduledCard
			.locator('label:has-text("SMS") input[type="checkbox"]')
			.first();
		if (!(await scheduledSmsCheckbox.isChecked())) {
			await scheduledSmsCheckbox.click();
		}

		const previousNextSendAt = await fetchNextSendAt(testUserId);
		await triggerSchedule(true);
		await waitForNextSendAdvance(testUserId, previousNextSendAt, 120_000);
	});

	test("TC-UNSUB-001: User can unsubscribe via email link", async () => {
		if (!testUserId) {
			throw new Error("testUserId not set before TC-UNSUB-001");
		}

		const token = createEmailUnsubscribeToken(testUserId, testEmail);
		const unsubscribeUrl = `${baseOrigin}/email/unsubscribe?user=${encodeURIComponent(testUserId)}&token=${encodeURIComponent(token)}`;
		await page.goto(unsubscribeUrl);
		await expect(page.getByText("Email notifications are now turned off.")).toBeVisible();

		await page.goto("/dashboard");
		const emailSwitch = page.getByRole("switch", {
			name: "Email notifications",
		});
		await expect(emailSwitch).toHaveAttribute("aria-checked", "false");
		await emailSwitch.click();
		await page.reload();
		await expect(emailSwitch).toHaveAttribute("aria-checked", "true");
	});

	test("TC-PROF-001: User can change password and update email", async () => {
		if (!testUserId) {
			throw new Error("testUserId not set before TC-PROF-001");
		}

		await page.goto("/profile");
		await page.locator("#new-password").fill(newPassword);
		await page.locator("#confirm-password").fill(newPassword);
		await page.getByRole("button", { name: "Update password" }).click();
		await expectCurrentPath(page, "/profile");
		await expect(page.getByText("Password updated successfully.")).toBeVisible();

		await page.getByRole("button", { name: "Sign Out" }).click();
		await expectCurrentPath(page, "/");
		await signIn(page, testEmail, newPassword);

		await page.goto("/profile");
		await page.locator("#new-email").fill(secondEmail);
		await page.getByRole("button", { name: "Update email" }).click();
		await expectCurrentPath(page, "/profile");
		await expect(
			page.getByText("Check your old and new inboxes to confirm the email change."),
		).toBeVisible();

		const newEmailMessage = await waitForEmail(
			secondEmail,
			"Confirm email change",
			60_000,
		);
		const oldEmailMessage = await maybeWaitForEmail(
			testEmail,
			"Confirm email change",
			60_000,
		);

		const candidateLinks = [
			...extractLinks(newEmailMessage),
			...(oldEmailMessage ? extractLinks(oldEmailMessage) : []),
		];
		const emailChangeLinks = [...new Set(candidateLinks)].filter(
			(link) => link.includes("token_hash=") && link.includes("type=email_change"),
		);
		expect(emailChangeLinks.length).toBeGreaterThan(0);

		for (const link of emailChangeLinks) {
			await page.goto(rewriteLinkOrigin(link, baseOrigin));
		}

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
			const params = {
				MessageSid: `SM${randomUUID().replaceAll("-", "").slice(0, 16)}`,
				AccountSid: "AC1234567890",
				From: inboundUserPhone,
				To: "+15551234567",
				Body: bodyValue,
			};
			const signature = computeTwilioSignature(authToken, webhookUrl, params);
			const body = new URLSearchParams(params);
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
