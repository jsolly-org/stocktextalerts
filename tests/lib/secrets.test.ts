import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock("@aws-sdk/client-ssm", () => ({
	// Classes (not arrow fns) so `new SSMClient()` / `new GetParameterCommand()` construct.
	SSMClient: class {
		send = sendMock;
	},
	GetParameterCommand: class {
		input: unknown;
		constructor(input: unknown) {
			this.input = input;
		}
	},
}));

// Synthetic names that never appear in .env.local (which vitest loads into
// process.env), so deleting them in setup/teardown can't clobber a real secret
// another test file relies on.
const NAME = "STA_TEST_SECRET";
const PARAM = "/stocktextalerts/sta-test-secret";
const OTHER = "STA_TEST_OTHER";
const OTHER_PARAM = "/stocktextalerts/sta-test-other";

function clearEnv() {
	delete process.env[NAME];
	delete process.env[`${NAME}_SSM_PARAM`];
	delete process.env[OTHER];
	delete process.env[`${OTHER}_SSM_PARAM`];
	// XAI_API_KEY is exercised by the optional-secret tests; .env.local may set it,
	// which would short-circuit the SSM path. Clear it (and its param) per test.
	delete process.env.XAI_API_KEY;
	delete process.env.XAI_API_KEY_SSM_PARAM;
}

// Re-import after vi.resetModules() so the module-level cache starts empty per test.
async function freshModule() {
	vi.resetModules();
	return import("../../src/lib/secrets");
}

beforeEach(() => {
	sendMock.mockReset();
	clearEnv();
});

afterEach(clearEnv);

describe("getSecret", () => {
	it("returns the <NAME> env var without calling SSM", async () => {
		process.env[NAME] = "env-secret";
		const { getSecret } = await freshModule();
		await expect(getSecret(NAME)).resolves.toBe("env-secret");
		expect(sendMock).not.toHaveBeenCalled();
	});

	it("throws when neither the env var nor the SSM param name is set", async () => {
		const { getSecret } = await freshModule();
		await expect(getSecret(NAME)).rejects.toThrow(new RegExp(NAME));
		expect(sendMock).not.toHaveBeenCalled();
	});

	it("fetches the SecureString with decryption and caches it across calls", async () => {
		process.env[`${NAME}_SSM_PARAM`] = PARAM;
		sendMock.mockResolvedValue({ Parameter: { Value: "ssm-secret" } });
		const { getSecret } = await freshModule();

		await expect(getSecret(NAME)).resolves.toBe("ssm-secret");
		await expect(getSecret(NAME)).resolves.toBe("ssm-secret");
		expect(sendMock).toHaveBeenCalledTimes(1); // cached
		expect(sendMock).toHaveBeenCalledWith(
			expect.objectContaining({ input: { Name: PARAM, WithDecryption: true } }),
		);
	});

	it("caches per-name (distinct secrets don't collide)", async () => {
		process.env[`${NAME}_SSM_PARAM`] = PARAM;
		process.env[`${OTHER}_SSM_PARAM`] = OTHER_PARAM;
		sendMock.mockImplementation((cmd: { input: { Name: string } }) =>
			Promise.resolve({ Parameter: { Value: cmd.input.Name === PARAM ? "first" : "second" } }),
		);
		const { getSecret } = await freshModule();

		await expect(getSecret(NAME)).resolves.toBe("first");
		await expect(getSecret(OTHER)).resolves.toBe("second");
		expect(sendMock).toHaveBeenCalledTimes(2);
	});

	it.each([
		["missing Value", { Parameter: {} }],
		["empty-string Value", { Parameter: { Value: "" } }],
	])("throws when the SSM parameter has %s", async (_label, response) => {
		process.env[`${NAME}_SSM_PARAM`] = PARAM;
		sendMock.mockResolvedValue(response);
		const { getSecret } = await freshModule();
		await expect(getSecret(NAME)).rejects.toThrow(/no value/);
	});

	it("does NOT cache a failed fetch — a transient SSM error is retried", async () => {
		process.env[`${NAME}_SSM_PARAM`] = PARAM;
		sendMock.mockRejectedValueOnce(new Error("AccessDeniedException"));
		const { getSecret } = await freshModule();

		await expect(getSecret(NAME)).rejects.toThrow(/AccessDenied/);
		sendMock.mockResolvedValue({ Parameter: { Value: "ssm-secret" } });
		await expect(getSecret(NAME)).resolves.toBe("ssm-secret");
		expect(sendMock).toHaveBeenCalledTimes(2);
	});

	it("env var wins even after the SSM value was cached", async () => {
		process.env[`${NAME}_SSM_PARAM`] = PARAM;
		sendMock.mockResolvedValue({ Parameter: { Value: "ssm-secret" } });
		const { getSecret } = await freshModule();

		await expect(getSecret(NAME)).resolves.toBe("ssm-secret"); // populates cache
		process.env[NAME] = "override";
		await expect(getSecret(NAME)).resolves.toBe("override");
		expect(sendMock).toHaveBeenCalledTimes(1); // env path skips SSM
	});
});

describe("loadSecretsIntoEnv", () => {
	it("populates process.env from SSM for names with a configured param", async () => {
		process.env[`${NAME}_SSM_PARAM`] = PARAM;
		sendMock.mockResolvedValue({ Parameter: { Value: "ssm-secret" } });
		const { loadSecretsIntoEnv } = await freshModule();

		await loadSecretsIntoEnv([NAME]);
		expect(process.env[NAME]).toBe("ssm-secret");
		expect(sendMock).toHaveBeenCalledTimes(1);
	});

	it("skips a name already set in process.env (Vercel / local — no SSM call)", async () => {
		process.env[NAME] = "already-here";
		process.env[`${NAME}_SSM_PARAM`] = PARAM;
		const { loadSecretsIntoEnv } = await freshModule();

		await loadSecretsIntoEnv([NAME]);
		expect(process.env[NAME]).toBe("already-here");
		expect(sendMock).not.toHaveBeenCalled();
	});

	it("skips a name with no <NAME>_SSM_PARAM (unconfigured in this runtime)", async () => {
		const { loadSecretsIntoEnv } = await freshModule();

		await loadSecretsIntoEnv([NAME]);
		expect(process.env[NAME]).toBeUndefined();
		expect(sendMock).not.toHaveBeenCalled();
	});

	it("fetches a mix in one batch, leaving unconfigured names untouched", async () => {
		process.env[`${NAME}_SSM_PARAM`] = PARAM;
		sendMock.mockResolvedValue({ Parameter: { Value: "fetched" } });
		const { loadSecretsIntoEnv } = await freshModule();

		await loadSecretsIntoEnv([NAME, OTHER]);
		expect(process.env[NAME]).toBe("fetched");
		expect(process.env[OTHER]).toBeUndefined();
		expect(sendMock).toHaveBeenCalledTimes(1);
	});

	it("propagates an SSM fetch failure (fail loud at cold start)", async () => {
		process.env[`${NAME}_SSM_PARAM`] = PARAM;
		sendMock.mockRejectedValue(new Error("AccessDeniedException"));
		const { loadSecretsIntoEnv } = await freshModule();

		await expect(loadSecretsIntoEnv([NAME])).rejects.toThrow(/AccessDenied/);
	});

	it("tolerates a ParameterNotFound for an optional secret (XAI_API_KEY), leaving it unset", async () => {
		process.env.XAI_API_KEY_SSM_PARAM = "/stocktextalerts/xai-api-key";
		const notFound = Object.assign(new Error("not found"), { name: "ParameterNotFound" });
		sendMock.mockRejectedValue(notFound);
		const { loadSecretsIntoEnv } = await freshModule();

		await expect(loadSecretsIntoEnv(["XAI_API_KEY"])).resolves.toBeUndefined();
		expect(process.env.XAI_API_KEY).toBeUndefined();
		delete process.env.XAI_API_KEY_SSM_PARAM;
	});

	it("still fails loud on a non-ParameterNotFound error for an optional secret", async () => {
		process.env.XAI_API_KEY_SSM_PARAM = "/stocktextalerts/xai-api-key";
		const denied = Object.assign(new Error("denied"), { name: "AccessDeniedException" });
		sendMock.mockRejectedValue(denied);
		const { loadSecretsIntoEnv } = await freshModule();

		await expect(loadSecretsIntoEnv(["XAI_API_KEY"])).rejects.toThrow(/denied/);
		delete process.env.XAI_API_KEY_SSM_PARAM;
	});
});
