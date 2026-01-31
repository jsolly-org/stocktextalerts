import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rootLogger } from "../src/lib/logging";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");

const SEED_PATH = path.join(projectRoot, "supabase", "seed.sql");

function main(): void {
  const databaseUrl = process.env.DATABASE_URL as string;

  rootLogger.info("Applying seed.sql to production via psql.", {
    context: { seedPath: SEED_PATH },
  });

  execFileSync("psql", ["-v", "ON_ERROR_STOP=1", "-f", SEED_PATH, databaseUrl], {
    stdio: "inherit",
  });
}

try {
  main();
} catch (error) {
  rootLogger.error("Seed production failed.", { context: { error: String(error) } });
  process.exit(1);
}
