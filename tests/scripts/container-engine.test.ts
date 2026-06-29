import { describe, expect, it } from "vitest";
import {
	isDockerHostReachable,
	isPodmanStorageCorruptionError,
	parseUnixDockerHost,
} from "../../scripts/db/container-engine";

describe("container-engine helpers", () => {
	describe("parseUnixDockerHost", () => {
		it("parses unix scheme paths", () => {
			expect(parseUnixDockerHost("unix:///var/run/docker.sock")).toBe("/var/run/docker.sock");
			expect(parseUnixDockerHost("  unix:///tmp/podman.sock  ")).toBe("/tmp/podman.sock");
		});

		it("returns null for non-unix schemes", () => {
			expect(parseUnixDockerHost("tcp://127.0.0.1:2375")).toBeNull();
			expect(parseUnixDockerHost("")).toBeNull();
		});
	});

	describe("isDockerHostReachable", () => {
		it("is false for invalid or non-unix hosts", () => {
			expect(isDockerHostReachable("tcp://127.0.0.1:2375")).toBe(false);
		});

		it("is false when the socket file is missing", () => {
			expect(isDockerHostReachable("unix:///nonexistent-socket-path-xyz")).toBe(false);
		});
	});

	describe("isPodmanStorageCorruptionError", () => {
		it("detects overlay readlink corruption", () => {
			expect(
				isPodmanStorageCorruptionError(
					"readlink /var/lib/containers/storage/overlay: invalid argument",
				),
			).toBe(true);
		});

		it("ignores unrelated errors", () => {
			expect(isPodmanStorageCorruptionError("failed to connect to docker daemon")).toBe(false);
			expect(isPodmanStorageCorruptionError("readlink only")).toBe(false);
		});
	});
});
