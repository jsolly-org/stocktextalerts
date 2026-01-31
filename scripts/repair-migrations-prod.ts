import { execFileSync } from "node:child_process";
import { rootLogger } from "../src/lib/logging";

type MigrationRow = {
  local: string | null;
  remote: string | null;
};

function parseMigrationList(output: string): MigrationRow[] {
  const rows: MigrationRow[] = [];
  const lines = output.split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.includes("Local") && line.includes("Remote")) continue;
    if (line.includes("---")) continue;
    const parts = line.split("|").map((part) => part.trim());
    if (parts.length < 2) continue;
    const local = parts[0] || null;
    const remote = parts[1] || null;
    if (!local && !remote) continue;
    rows.push({ local, remote });
  }
  return rows;
}

function main(): void {
  const output = execFileSync("supabase", ["migration", "list"], {
    encoding: "utf-8",
  });
  const rows = parseMigrationList(output);

  const remoteOnly = rows
    .filter((row) => !row.local && row.remote)
    .map((row) => row.remote as string);

  if (remoteOnly.length === 0) {
    rootLogger.info("No remote-only migrations to repair.", { context: {} });
    return;
  }

  rootLogger.info("Marking remote-only migrations as reverted.", {
    context: { count: remoteOnly.length },
  });

  execFileSync(
    "supabase",
    ["migration", "repair", "--status", "reverted", ...remoteOnly],
    { stdio: "inherit" },
  );
}

try {
  main();
} catch (error) {
  rootLogger.error("Repair migrations failed.", { context: { error: String(error) } });
  process.exit(1);
}
