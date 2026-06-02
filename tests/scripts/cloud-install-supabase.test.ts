import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = process.cwd();

function runBash(script: string): string {
	const result = spawnSync("bash", ["--noprofile", "--norc", "-c", script], {
		cwd: projectRoot,
		encoding: "utf8",
		env: {
			...process.env,
			PATH: process.env.PATH ?? "",
		},
	});
	const output = `${result.stdout}${result.stderr}`;
	if (result.status !== 0) {
		throw new Error(output);
	}
	return output;
}

describe("Cursor Cloud Supabase CLI bootstrap", () => {
	it("retries npm ci when dependency lifecycle downloads fail transiently", () => {
		const tempDir = mkdtempSync(path.join(os.tmpdir(), "supabase-npm-ci-"));
		try {
			const output = runBash(`
				set -euo pipefail
				repo=${JSON.stringify(tempDir)}
				mkdir -p "$repo/fake-bin"
				cat > "$repo/fake-bin/npm" <<'NPM'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "ci" ]]; then
	attempts_file="$PWD/attempts"
	attempts=0
	if [[ -f "$attempts_file" ]]; then
		attempts="$(<"$attempts_file")"
	fi
	attempts=$((attempts + 1))
	printf '%s\\n' "$attempts" > "$attempts_file"
	if [[ "$attempts" -eq 1 ]]; then
		echo "simulated postinstall download failure" >&2
		exit 42
	fi
	exit 0
fi
echo "unexpected npm invocation: $*" >&2
exit 1
NPM
				chmod +x "$repo/fake-bin/npm"
				PATH="$repo/fake-bin:$PATH"
				cd "$repo"
				source ${JSON.stringify(path.join(projectRoot, "scripts/cloud-install-supabase.sh"))}
				npm_ci_for_cloud "$repo"
				printf 'attempts=%s\\n' "$(<"$repo/attempts")"
			`);

			expect(output).toContain("npm ci — attempt 1/3");
			expect(output).toContain("npm ci — transient failure, retrying");
			expect(output).toContain("npm ci — attempt 2/3");
			expect(output).toContain("attempts=2");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("rebuilds the npm Supabase CLI when postinstall left no runnable binary", () => {
		const tempDir = mkdtempSync(path.join(os.tmpdir(), "supabase-cli-bootstrap-"));
		try {
			const output = runBash(`
				set -euo pipefail
				repo=${JSON.stringify(tempDir)}
				mkdir -p "$repo/node_modules/.bin" "$repo/node_modules/supabase" "$repo/fake-bin"
				cat > "$repo/fake-bin/npm" <<'NPM'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "rebuild" && "$2" == "supabase" ]]; then
	mkdir -p "$PWD/node_modules/supabase/bin" "$PWD/node_modules/.bin"
	cat > "$PWD/node_modules/supabase/bin/supabase" <<'SUPABASE'
#!/usr/bin/env bash
echo "supabase cli v2.88.1"
SUPABASE
	chmod +x "$PWD/node_modules/supabase/bin/supabase"
	ln -sf ../supabase/bin/supabase "$PWD/node_modules/.bin/supabase"
	exit 0
fi
echo "unexpected npm invocation: $*" >&2
exit 1
NPM
				chmod +x "$repo/fake-bin/npm"
				PATH="$repo/fake-bin:$PATH"
				cd "$repo"
				cloud_install_log() { echo "cloud-install: $*"; }
				source ${JSON.stringify(path.join(projectRoot, "scripts/cloud-install-supabase.sh"))}
				ensure_supabase_cli_for_cloud "$repo"
			`);

			expect(output).toContain("Supabase CLI — npm rebuild attempt 1/3");
			expect(output).toContain("Supabase CLI — ready");
			expect(
				readFileSync(path.join(tempDir, "node_modules/supabase/bin/supabase"), "utf8"),
			).toContain("supabase cli v2.88.1");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("reports a missing CLI during cleanup and still removes stale Docker containers and networks", () => {
		const tempDir = mkdtempSync(path.join(os.tmpdir(), "supabase-cleanup-"));
		try {
			const output = runBash(`
				set -euo pipefail
				repo=${JSON.stringify(tempDir)}
				mkdir -p "$repo/fake-bin"
				cat > "$repo/fake-bin/docker" <<'DOCKER'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$DOCKER_CALLS"
if [[ "$1" == "ps" ]]; then
	echo "stale-container-1"
	exit 0
fi
if [[ "$1" == "network" && "$2" == "ls" ]]; then
	echo "stale-network-1"
	exit 0
fi
exit 0
DOCKER
				chmod +x "$repo/fake-bin/docker"
				export DOCKER_CALLS="$repo/docker-calls.txt"
				PATH="$repo/fake-bin:$PATH"
				cloud_install_log() { echo "cloud-install: $*"; }
				source ${JSON.stringify(path.join(projectRoot, "scripts/cloud-install-supabase.sh"))}
				supabase_clean_docker_state_for_cloud "$repo/node_modules/.bin/supabase"
				echo "--- docker calls ---"
				cat "$DOCKER_CALLS"
			`);

			expect(output).toContain("Supabase CLI — not available for stop");
			expect(output).toContain("rm -f stale-container-1");
			expect(output).toContain("network rm stale-network-1");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
