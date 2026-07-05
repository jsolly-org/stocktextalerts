import { describe, expect, it } from "vitest";
import { resolveRegistrationEnabled } from "../../src/lib/constants";

/**
 * The registration gate must FAIL CLOSED: a private two-person app should never reopen
 * public signups because a deploy-time env var went missing. It opens only on an explicit
 * `true` override or a positive local/CI/test signal.
 */
describe("resolveRegistrationEnabled", () => {
	it("honors an explicit `true` override in any environment (trimmed + case-insensitive)", () => {
		expect(
			resolveRegistrationEnabled({
				registrationEnabled: "true",
				nodeEnv: "production",
				mode: undefined,
			}),
		).toBe(true);
		expect(
			resolveRegistrationEnabled({
				registrationEnabled: "  TRUE  ",
				nodeEnv: "production",
				mode: undefined,
			}),
		).toBe(true);
	});

	it("honors an explicit `false` override even when a dev/test signal is present", () => {
		expect(
			resolveRegistrationEnabled({
				registrationEnabled: "false",
				nodeEnv: "development",
				mode: "test",
			}),
		).toBe(false);
	});

	it("opens with no override on a dev or test NODE_ENV (local dev, vitest)", () => {
		expect(
			resolveRegistrationEnabled({
				registrationEnabled: undefined,
				nodeEnv: "development",
				mode: undefined,
			}),
		).toBe(true);
		expect(
			resolveRegistrationEnabled({
				registrationEnabled: undefined,
				nodeEnv: "test",
				mode: undefined,
			}),
		).toBe(true);
	});

	it("opens for the MODE=test Playwright preview server (production build, no override)", () => {
		expect(
			resolveRegistrationEnabled({
				registrationEnabled: undefined,
				nodeEnv: "production",
				mode: "test",
			}),
		).toBe(true);
	});

	it("fails CLOSED on a real deploy: production build, no test MODE, no override", () => {
		expect(
			resolveRegistrationEnabled({
				registrationEnabled: undefined,
				nodeEnv: "production",
				mode: undefined,
			}),
		).toBe(false);
	});

	it("fails CLOSED when every signal is missing (no silent reopen on misconfig)", () => {
		expect(
			resolveRegistrationEnabled({
				registrationEnabled: undefined,
				nodeEnv: undefined,
				mode: undefined,
			}),
		).toBe(false);
	});

	it("treats an empty/whitespace override as unset and falls through to the signal check", () => {
		expect(
			resolveRegistrationEnabled({
				registrationEnabled: "   ",
				nodeEnv: "production",
				mode: undefined,
			}),
		).toBe(false);
		expect(
			resolveRegistrationEnabled({
				registrationEnabled: "",
				nodeEnv: "development",
				mode: undefined,
			}),
		).toBe(true);
	});
});
