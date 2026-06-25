import { describe, expect, it } from "vitest";
import {
	compareSubjects,
	type ExpectedSubject,
	parseContainerSubjects,
	readExpectedSubjects,
} from "../../scripts/db/gotrue-config";

// A faithful slice of supabase/config.toml's auth email section, including the em-dash that must
// round-trip byte-for-byte against the GOTRUE_MAILER_SUBJECTS_* env the auth container bakes.
const CONFIG_TOML = `
[auth]
site_url = "http://localhost:4321"

[auth.email]
enable_confirmations = true

[auth.email.template.confirmation]
subject = "Confirm your email — StockTextAlerts"
content_path = "./supabase/auth-confirmation.html"

[auth.email.template.recovery]
subject = "Reset your password — StockTextAlerts"
content_path = "./supabase/auth-recovery.html"

[auth.email.template.email_change]
subject = "Confirm your email change — StockTextAlerts"
content_path = "./supabase/auth-email-change.html"

[auth.email.notification.password_changed]
enabled = true
subject = "Your password has been changed — StockTextAlerts"
content_path = "./auth-password-changed.html"
`;

describe("readExpectedSubjects — what GoTrue should serve, from config.toml", () => {
	it("maps each declared email subject to its GoTrue env var, preserving the em-dash", () => {
		const subjects = readExpectedSubjects(CONFIG_TOML);
		const byEnv = new Map(subjects.map((s) => [s.envKey, s.subject]));

		expect(byEnv.get("GOTRUE_MAILER_SUBJECTS_CONFIRMATION")).toBe(
			"Confirm your email — StockTextAlerts",
		);
		expect(byEnv.get("GOTRUE_MAILER_SUBJECTS_RECOVERY")).toBe(
			"Reset your password — StockTextAlerts",
		);
		expect(byEnv.get("GOTRUE_MAILER_SUBJECTS_EMAIL_CHANGE")).toBe(
			"Confirm your email change — StockTextAlerts",
		);
		expect(byEnv.get("GOTRUE_MAILER_SUBJECTS_PASSWORD_CHANGED_NOTIFICATION")).toBe(
			"Your password has been changed — StockTextAlerts",
		);
		expect(subjects).toHaveLength(4);
	});

	it("only enforces subjects that are actually declared (a removed one stops being checked)", () => {
		const partial = `
[auth.email.template.confirmation]
subject = "Confirm your email — StockTextAlerts"
`;
		const subjects = readExpectedSubjects(partial);
		expect(subjects).toHaveLength(1);
		expect(subjects[0]?.envKey).toBe("GOTRUE_MAILER_SUBJECTS_CONFIRMATION");
	});

	it("returns nothing when no email subjects are declared", () => {
		expect(readExpectedSubjects(`[auth]\nsite_url = "http://localhost:4321"\n`)).toEqual([]);
	});

	it("parses a single-quoted subject identically to a double-quoted one (TOML allows both)", () => {
		const single = `
[auth.email.template.confirmation]
subject = 'Confirm your email — StockTextAlerts'
`;
		expect(readExpectedSubjects(single)).toEqual([
			{
				key: "confirmation",
				envKey: "GOTRUE_MAILER_SUBJECTS_CONFIRMATION",
				subject: "Confirm your email — StockTextAlerts",
			},
		]);
	});

	it("strips a trailing inline comment without bleeding it into the subject", () => {
		const withComment = `
[auth.email.template.confirmation]
subject = "Confirm your email — StockTextAlerts"  # keep in sync with the HTML template
`;
		expect(readExpectedSubjects(withComment)[0]?.subject).toBe(
			"Confirm your email — StockTextAlerts",
		);
	});

	it("ignores a `subject =` line under a table that isn't one of the four enforced ones", () => {
		// A stray/typo'd table must not have its subject mis-assigned to the last-seen key.
		const withStray = `
[auth.email.template.confirmation]
subject = "Confirm your email — StockTextAlerts"

[auth.sms.template.confirm]
subject = "irrelevant SMS subject"
`;
		const subjects = readExpectedSubjects(withStray);
		expect(subjects).toHaveLength(1);
		expect(subjects[0]).toEqual({
			key: "confirmation",
			envKey: "GOTRUE_MAILER_SUBJECTS_CONFIRMATION",
			subject: "Confirm your email — StockTextAlerts",
		});
	});
});

describe("parseContainerSubjects — reading the auth container's baked env", () => {
	it("extracts only the GOTRUE_MAILER_SUBJECTS_* lines and ignores everything else", () => {
		const env = [
			"PATH=/usr/bin",
			"GOTRUE_SITE_URL=http://localhost:4321",
			"GOTRUE_MAILER_SUBJECTS_CONFIRMATION=Confirm your email — StockTextAlerts",
			"GOTRUE_MAILER_SUBJECTS_RECOVERY=Reset your password — StockTextAlerts",
		];
		const map = parseContainerSubjects(env);
		expect(map.size).toBe(2);
		expect(map.get("GOTRUE_MAILER_SUBJECTS_CONFIRMATION")).toBe(
			"Confirm your email — StockTextAlerts",
		);
		expect(map.has("GOTRUE_SITE_URL")).toBe(false);
	});

	it("splits on the first '=' so a subject containing '=' survives intact", () => {
		const map = parseContainerSubjects(["GOTRUE_MAILER_SUBJECTS_CONFIRMATION=A = B reminder"]);
		expect(map.get("GOTRUE_MAILER_SUBJECTS_CONFIRMATION")).toBe("A = B reminder");
	});
});

describe("compareSubjects — drift verdict", () => {
	const expected: ExpectedSubject[] = readExpectedSubjects(CONFIG_TOML);

	it("is in_sync when the container serves every declared subject verbatim", () => {
		const actual = new Map(expected.map((e) => [e.envKey, e.subject]));
		expect(compareSubjects(expected, actual)).toEqual({ status: "in_sync" });
	});

	it("flags the default GoTrue subject as drift (the real failing-spec scenario)", () => {
		const actual = new Map(expected.map((e) => [e.envKey, e.subject]));
		actual.set("GOTRUE_MAILER_SUBJECTS_CONFIRMATION", "Confirm Your Signup");

		const verdict = compareSubjects(expected, actual);
		expect(verdict.status).toBe("drifted");
		if (verdict.status !== "drifted") throw new Error("unreachable");
		expect(verdict.mismatches).toEqual([
			{
				envKey: "GOTRUE_MAILER_SUBJECTS_CONFIRMATION",
				expected: "Confirm your email — StockTextAlerts",
				actual: "Confirm Your Signup",
			},
		]);
	});

	it("treats a missing env var (container never set the subject) as drift, with actual null", () => {
		const actual = new Map(expected.map((e) => [e.envKey, e.subject]));
		actual.delete("GOTRUE_MAILER_SUBJECTS_RECOVERY");

		const verdict = compareSubjects(expected, actual);
		expect(verdict.status).toBe("drifted");
		if (verdict.status !== "drifted") throw new Error("unreachable");
		// Only the deleted subject drifts — the other three still match.
		expect(verdict.mismatches).toHaveLength(1);
		expect(verdict.mismatches).toContainEqual({
			envKey: "GOTRUE_MAILER_SUBJECTS_RECOVERY",
			expected: "Reset your password — StockTextAlerts",
			actual: null,
		});
	});
});
