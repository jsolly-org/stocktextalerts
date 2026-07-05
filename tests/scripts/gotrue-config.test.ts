import { describe, expect, it } from "vitest";
import {
	type ExpectedTemplate,
	evaluateCanaryProbe,
	normalizeTemplateBody,
	parseContainerTemplateUrls,
	parseWgetStatus,
	readExpectedTemplates,
} from "../../scripts/db/gotrue-config";

// A faithful slice of supabase/config.toml's auth email section. Each template is declared via a
// `content_path` HTML file that the Supabase CLI mounts and serves through kong; the drift detector
// probes whether GoTrue can still load it.
const CONFIG_TOML = `
[auth]
site_url = "http://localhost:4321"

[auth.email]
enable_confirmations = true

[auth.email.template.confirmation]
subject = "Confirm your email — StockTextAlerts"
content_path = "./supabase/templates/auth-confirmation.html"

[auth.email.template.recovery]
subject = "Reset your password — StockTextAlerts"
content_path = "./supabase/templates/auth-recovery.html"

[auth.email.template.email_change]
subject = "Confirm your email change — StockTextAlerts"
content_path = "./supabase/templates/auth-email-change.html"

[auth.email.notification.password_changed]
enabled = true
subject = "Your password has been changed — StockTextAlerts"
content_path = "./templates/auth-password-changed.html"
`;

const CONFIRMATION: ExpectedTemplate = {
	key: "confirmation",
	envKey: "GOTRUE_MAILER_TEMPLATES_CONFIRMATION",
	contentPath: "./supabase/templates/auth-confirmation.html",
};
const TEMPLATE_URL = "http://supabase_kong_stocktextalerts:8088/email/confirmation.html";
const OUR_TEMPLATE = "<html><body>Confirm your email — StockTextAlerts</body></html>";

describe("readExpectedTemplates — which branded templates config.toml expects GoTrue to serve", () => {
	it("maps each declared template to its GoTrue env var and on-disk path, confirmation first", () => {
		const templates = readExpectedTemplates(CONFIG_TOML);
		// Confirmation leads (it's the canary the route probe checks) and email_change precedes the
		// password_changed notification, matching CANARY_PRIORITY.
		expect(templates.map((t) => t.key)).toEqual([
			"confirmation",
			"recovery",
			"email_change",
			"password_changed",
		]);
		const confirmation = templates.find((t) => t.key === "confirmation");
		expect(confirmation).toEqual(CONFIRMATION);
	});

	it("only enforces templates that declare a content_path (a removed one stops being checked)", () => {
		const partial = `
[auth.email.template.confirmation]
content_path = "./supabase/templates/auth-confirmation.html"
`;
		const templates = readExpectedTemplates(partial);
		expect(templates).toHaveLength(1);
		expect(templates[0]?.envKey).toBe("GOTRUE_MAILER_TEMPLATES_CONFIRMATION");
	});

	it("returns nothing when no templates are declared (config defers to GoTrue defaults)", () => {
		expect(readExpectedTemplates(`[auth]\nsite_url = "http://localhost:4321"\n`)).toEqual([]);
	});

	it("does not mis-assign a content_path under a table that isn't one of the four enforced ones", () => {
		const withStray = `
[auth.email.template.confirmation]
content_path = "./supabase/templates/auth-confirmation.html"

[auth.mfa.template.confirm]
content_path = "./irrelevant.txt"
`;
		const templates = readExpectedTemplates(withStray);
		expect(templates).toHaveLength(1);
		expect(templates[0]?.key).toBe("confirmation");
	});
});

describe("parseContainerTemplateUrls — reading the auth container's template URLs", () => {
	it("extracts only the GOTRUE_MAILER_TEMPLATES_* lines and ignores everything else", () => {
		const env = [
			"PATH=/usr/bin",
			"GOTRUE_SITE_URL=http://localhost:4321",
			`GOTRUE_MAILER_TEMPLATES_CONFIRMATION=${TEMPLATE_URL}`,
			"GOTRUE_MAILER_SUBJECTS_CONFIRMATION=Confirm your email — StockTextAlerts",
		];
		const map = parseContainerTemplateUrls(env);
		expect(map.size).toBe(1);
		expect(map.get("GOTRUE_MAILER_TEMPLATES_CONFIRMATION")).toBe(TEMPLATE_URL);
		expect(map.has("GOTRUE_MAILER_SUBJECTS_CONFIRMATION")).toBe(false);
	});

	it("splits on the first '=' so a URL containing '=' survives intact", () => {
		const map = parseContainerTemplateUrls([
			"GOTRUE_MAILER_TEMPLATES_CONFIRMATION=http://kong/email?x=1&y=2",
		]);
		expect(map.get("GOTRUE_MAILER_TEMPLATES_CONFIRMATION")).toBe("http://kong/email?x=1&y=2");
	});
});

describe("parseWgetStatus — reading the HTTP status from busybox wget -S output", () => {
	it("reads a 200 from the response status line", () => {
		expect(parseWgetStatus("  HTTP/1.1 200 OK\n  Content-Type: text/html")).toBe(200);
	});

	it("reads a 404 — the real recurring failure when the kong template route is gone", () => {
		expect(parseWgetStatus("wget: server returned error: HTTP/1.1 404 Not Found")).toBe(404);
	});

	it("returns null when there is no HTTP status line (wget couldn't reach the route)", () => {
		expect(parseWgetStatus("wget: bad address 'supabase_kong_stocktextalerts'")).toBeNull();
	});
});

describe("normalizeTemplateBody — tolerating benign whitespace when comparing bodies", () => {
	it("treats a body with a trailing newline as equal to one without", () => {
		expect(normalizeTemplateBody(`${OUR_TEMPLATE}\n`)).toBe(normalizeTemplateBody(OUR_TEMPLATE));
	});

	it("normalizes CRLF line endings to LF", () => {
		expect(normalizeTemplateBody("a\r\nb")).toBe("a\nb");
	});
});

describe("evaluateCanaryProbe — can GoTrue serve our branded confirmation template?", () => {
	it("is in_sync (no mismatch) when the route serves our template verbatim", () => {
		const probe = { kind: "http" as const, status: 200, body: `${OUR_TEMPLATE}\n` };
		expect(evaluateCanaryProbe(CONFIRMATION, OUR_TEMPLATE, TEMPLATE_URL, probe)).toBeNull();
	});

	it("flags a 404 as drift — the real failing-spec scenario (GoTrue falls back to its default)", () => {
		const probe = { kind: "http" as const, status: 404, body: "" };
		const mismatch = evaluateCanaryProbe(CONFIRMATION, OUR_TEMPLATE, TEMPLATE_URL, probe);
		expect(mismatch).toMatchObject({ key: "confirmation", reason: "route_unavailable" });
		expect(mismatch?.detail).toContain("404");
	});

	it("flags a 200 that serves different content as drift (a stale template mount)", () => {
		const probe = {
			kind: "http" as const,
			status: 200,
			body: "<html><body>Confirm Your Signup</body></html>",
		};
		const mismatch = evaluateCanaryProbe(CONFIRMATION, OUR_TEMPLATE, TEMPLATE_URL, probe);
		expect(mismatch).toMatchObject({ key: "confirmation", reason: "content_mismatch" });
	});

	it("flags a missing template env as drift — GoTrue is pointed nowhere, so it uses the default", () => {
		const probe = { kind: "unreachable" as const, detail: "" };
		const mismatch = evaluateCanaryProbe(CONFIRMATION, OUR_TEMPLATE, null, probe);
		expect(mismatch).toMatchObject({
			key: "confirmation",
			url: null,
			reason: "template_env_missing",
		});
	});
});
