# User-Settings Backup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** docs/specs/2026-06-13-user-settings-backup-design.md

**Goal:** A 5×/day SAM-managed Lambda that exports 4 user-authored tables via Postgres `COPY` inside one `REPEATABLE READ` transaction, gzips them with a manifest, and writes one object to a private S3 bucket — with least-privilege creds and failure + staleness alarms.

**Architecture:** Pure, unit-testable modules in `src/lib/backup/` (table list, manifest, COPY export, storage/SSM) composed by a thin handler `src/handlers/backup-user-settings.ts`. Infra (S3 bucket, schedule, IAM, alarms) added to `aws/template.yaml`. A `backup_readonly` Postgres role is created by a committed migration; its password and SSM connection string are set once by a human (see spec "out-of-band steps"). Restore is a standalone script + runbook, exercised once as the completion gate.

**Tech Stack:** Node 24 / TypeScript, `pg` + `pg-copy-streams` (COPY streaming), `@aws-sdk/client-s3` / `-ssm` / `-cloudwatch`, AWS SAM, Vitest (against local Supabase), Biome.

---

## File Structure

- `src/lib/backup/tables.ts` — the canonical list of backed-up tables (single source of truth).
- `src/lib/backup/manifest.ts` — pure manifest builder + types.
- `src/lib/backup/export.ts` — `exportSnapshot()`: opens one repeatable-read transaction, COPYs each table to a buffer, returns `{ tables, manifest }`.
- `src/lib/backup/storage.ts` — `getConnectionString()` (SSM), `putBackup()` (gzip + S3), `emitHeartbeat()` (CloudWatch).
- `src/handlers/backup-user-settings.ts` — Lambda handler wiring logger + the modules above.
- `scripts/backup/restore.ts` — restore an object into a target Postgres.
- `supabase/migrations/<ts>_backup_readonly_role.sql` — role + SELECT grants + schema_version bump.
- `aws/template.yaml` — function, log group, schedule, bucket, lifecycle, IAM, alarms.
- `docs/backups.md` — restore runbook + out-of-band setup.
- Tests under `tests/lib/backup/`.

---

## Task 1: Add dependencies

**Files:**

- Modify: `package.json`

- [ ] **Step 1: Install runtime + dev deps**

Run:

```bash
npm install pg-copy-streams @aws-sdk/client-s3 @aws-sdk/client-ssm @aws-sdk/client-cloudwatch
npm install -D @types/pg-copy-streams
```

Expected: `package.json` gains the four runtime deps and one dev type package. `pg` / `@types/pg` already present.

- [ ] **Step 2: Verify install + types resolve**

Run: `npm run check:ts`
Expected: PASS (no missing-module errors).

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(backup): add pg-copy-streams + aws sdk clients for user-settings backup"
```

---

## Task 2: `backup_readonly` role migration

**Files:**

- Create: `supabase/migrations/<timestamp>_backup_readonly_role.sql` (via `supabase migration new backup_readonly_role`)
- Modify: `tests/helpers/constants.ts` (EXPECTED_DB_SCHEMA_VERSION)

- [ ] **Step 1: Generate the migration file**

Run: `supabase migration new backup_readonly_role`
Expected: prints a new path `supabase/migrations/<timestamp>_backup_readonly_role.sql`. **Record `<timestamp>`** — it is the new schema version.

- [ ] **Step 2: Write the migration SQL**

Write into the new file:

```sql
-- Least-privilege role for the user-settings backup Lambda.
-- Created with NO password and NOLOGIN here: it cannot authenticate until a
-- human sets a password out-of-band (ALTER ROLE ... PASSWORD), per
-- docs/specs/2026-06-13-user-settings-backup-design.md.
-- This migration is the source of truth for the role's PRIVILEGES only.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'backup_readonly') then
    create role backup_readonly nologin;
  end if;
end$$;

grant usage on schema public to backup_readonly;

grant select on table
  public.users,
  public.user_assets,
  public.price_targets,
  public.scheduled_notifications
to backup_readonly;

-- Bump schema version (matches EXPECTED_DB_SCHEMA_VERSION in tests).
-- app_metadata is a key/value table: the column is `value`, keyed by `key`.
update public.app_metadata
set value = '<timestamp>_backup_readonly_role'
where key = 'schema_version';
```

Replace `<timestamp>_backup_readonly_role` with the actual filename stem from Step 1.

- [ ] **Step 3: Update the expected schema version constant**

In `tests/helpers/constants.ts`, set:

```ts
export const EXPECTED_DB_SCHEMA_VERSION = "<timestamp>_backup_readonly_role";
```

- [ ] **Step 4: Apply locally + regenerate types + run the privilege/grant gates**

Run: `npm run db:reset && npm run db:gen-types && npm run check:sql && npm run check:migration-grants && npm run check:db-privileges`
Expected: all PASS. `check:migration-grants` is satisfied (no new RPC function added; only table SELECT grants). `db:reset` applies cleanly.

- [ ] **Step 5: Confirm the role exists locally with exactly SELECT on the 4 tables**

Run:

```bash
psql "$DATABASE_URL" -c "select grantee, table_name, privilege_type from information_schema.role_table_grants where grantee='backup_readonly' order by table_name;"
```

Expected: exactly four rows, all `SELECT`, for `price_targets`, `scheduled_notifications`, `user_assets`, `users`.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations tests/helpers/constants.ts src/lib/db/generated/database.types.ts
git commit -m "feat(backup): add backup_readonly role with SELECT on the 4 user tables"
```

---

## Task 3: Table list module

**Files:**

- Create: `src/lib/backup/tables.ts`
- Test: `tests/lib/backup/tables.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { BACKUP_TABLES } from "../../../src/lib/backup/tables";

describe("BACKUP_TABLES", () => {
  it("is exactly the four user-authored tables, schema-qualified", () => {
    expect(BACKUP_TABLES).toEqual([
      "public.users",
      "public.user_assets",
      "public.price_targets",
      "public.scheduled_notifications",
    ]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/lib/backup/tables.test.ts`
Expected: FAIL — cannot find module `tables`.

- [ ] **Step 3: Implement**

Create `src/lib/backup/tables.ts`:

```ts
/**
 * The user-authored tables this backup preserves. Source of truth for both the
 * export (Task 4) and restore (Task 8). Order is parent-before-child so a naive
 * restore satisfies FKs. See docs/specs/2026-06-13-user-settings-backup-design.md.
 */
export const BACKUP_TABLES = [
  "public.users",
  "public.user_assets",
  "public.price_targets",
  "public.scheduled_notifications",
] as const;

export type BackupTable = (typeof BACKUP_TABLES)[number];
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test -- tests/lib/backup/tables.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/backup/tables.ts tests/lib/backup/tables.test.ts
git commit -m "feat(backup): add canonical backup table list"
```

---

## Task 4: Manifest builder

**Files:**

- Create: `src/lib/backup/manifest.ts`
- Test: `tests/lib/backup/manifest.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { buildManifest } from "../../../src/lib/backup/manifest";

describe("buildManifest", () => {
  it("captures timestamp, schema version, and per-table row counts", () => {
    const m = buildManifest({
      takenAt: "2026-06-13T12:00:00.000Z",
      schemaVersion: "20260613121934_email_dispatch_idempotency",
      rowCounts: { "public.users": 3, "public.user_assets": 7 },
    });
    expect(m.taken_at).toBe("2026-06-13T12:00:00.000Z");
    expect(m.schema_version).toBe("20260613121934_email_dispatch_idempotency");
    expect(m.row_counts["public.users"]).toBe(3);
    expect(m.format).toBe("pg-copy-text-v1");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/lib/backup/manifest.test.ts`
Expected: FAIL — cannot find module `manifest`.

- [ ] **Step 3: Implement**

Create `src/lib/backup/manifest.ts`:

```ts
export type BackupManifest = {
  format: "pg-copy-text-v1";
  taken_at: string;
  schema_version: string;
  row_counts: Record<string, number>;
};

export function buildManifest(input: {
  takenAt: string;
  schemaVersion: string;
  rowCounts: Record<string, number>;
}): BackupManifest {
  return {
    format: "pg-copy-text-v1",
    taken_at: input.takenAt,
    schema_version: input.schemaVersion,
    row_counts: input.rowCounts,
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test -- tests/lib/backup/manifest.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/backup/manifest.ts tests/lib/backup/manifest.test.ts
git commit -m "feat(backup): add backup manifest builder"
```

---

## Task 5: COPY export (integration against local Supabase)

**Files:**

- Create: `src/lib/backup/export.ts`
- Test: `tests/lib/backup/export.test.ts`

> Note: this test uses the **real** local Supabase Postgres via `DATABASE_URL` (per
> project testing conventions). Local Supabase must be up (`npm run db:start`).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { exportSnapshot } from "../../../src/lib/backup/export";
import { EXPECTED_DB_SCHEMA_VERSION } from "../../helpers/constants";

describe("exportSnapshot", () => {
  it("returns COPY text for every table plus a consistent manifest", async () => {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) throw new Error("DATABASE_URL not set (start local Supabase)");

    const snap = await exportSnapshot({ connectionString: dbUrl });

    // One COPY payload per table.
    expect(Object.keys(snap.tables).sort()).toEqual([
      "public.price_targets",
      "public.scheduled_notifications",
      "public.user_assets",
      "public.users",
    ]);
    // Manifest row counts match the line count of each COPY payload.
    for (const [table, text] of Object.entries(snap.tables)) {
      const lines = text === "" ? 0 : text.split("\n").filter((l) => l.length > 0).length;
      expect(snap.manifest.row_counts[table]).toBe(lines);
    }
    expect(snap.manifest.schema_version).toBe(EXPECTED_DB_SCHEMA_VERSION);
    expect(snap.manifest.format).toBe("pg-copy-text-v1");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/lib/backup/export.test.ts`
Expected: FAIL — cannot find module `export`.

- [ ] **Step 3: Implement**

Create `src/lib/backup/export.ts`:

```ts
import { Client } from "pg";
import { to as copyTo } from "pg-copy-streams";
import { buildManifest, type BackupManifest } from "./manifest";
import { BACKUP_TABLES } from "./tables";

export type Snapshot = {
  tables: Record<string, string>;
  manifest: BackupManifest;
};

/** Drain a COPY-to-STDOUT stream into a UTF-8 string. */
function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", reject);
  });
}

/** COPY text format terminates every row with a newline; embedded newlines are
 * escaped, so counting '\n' bytes is an exact row count. */
function countRows(copyText: string): number {
  if (copyText.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < copyText.length; i++) if (copyText.charCodeAt(i) === 10) count++;
  return count;
}

export async function exportSnapshot(opts: { connectionString: string }): Promise<Snapshot> {
  // sslmode=require: encrypt to the Supabase pooler without local CA pinning.
  const client = new Client({
    connectionString: opts.connectionString,
    ssl: opts.connectionString.includes("sslmode=") ? undefined : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    // One snapshot across all tables → no torn FK rows.
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");

    const schemaRes = await client.query<{ schema_version: string }>(
      "select schema_version from public.app_metadata limit 1",
    );
    const schemaVersion = schemaRes.rows[0]?.schema_version ?? "unknown";

    const tables: Record<string, string> = {};
    const rowCounts: Record<string, number> = {};
    for (const table of BACKUP_TABLES) {
      const stream = client.query(copyTo(`COPY ${table} TO STDOUT`));
      const text = await streamToString(stream);
      tables[table] = text;
      rowCounts[table] = countRows(text);
    }

    await client.query("COMMIT");

    return {
      tables,
      manifest: buildManifest({
        takenAt: new Date().toISOString(),
        schemaVersion,
        rowCounts,
      }),
    };
  } finally {
    await client.end();
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test -- tests/lib/backup/export.test.ts`
Expected: PASS (requires local Supabase up).

- [ ] **Step 5: Commit**

```bash
git add src/lib/backup/export.ts tests/lib/backup/export.test.ts
git commit -m "feat(backup): COPY export of user tables in one repeatable-read transaction"
```

---

## Task 6: Storage — SSM fetch, gzip + S3 put, heartbeat

**Files:**

- Create: `src/lib/backup/storage.ts`
- Test: `tests/lib/backup/storage.test.ts`

- [ ] **Step 1: Write the failing test (mock the AWS SDK clients)**

```ts
import { gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";

const send = vi.fn().mockResolvedValue({});
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn(() => ({ send })),
  PutObjectCommand: vi.fn((input) => ({ __type: "put", input })),
}));

import { packBackup } from "../../../src/lib/backup/storage";

describe("packBackup", () => {
  it("gzips a JSON envelope of manifest + tables", () => {
    const buf = packBackup({
      manifest: {
        format: "pg-copy-text-v1",
        taken_at: "2026-06-13T12:00:00.000Z",
        schema_version: "v1",
        row_counts: { "public.users": 1 },
      },
      tables: { "public.users": "1\tjohn@x.com\n" },
    });
    const parsed = JSON.parse(gunzipSync(buf).toString("utf8"));
    expect(parsed.manifest.schema_version).toBe("v1");
    expect(parsed.tables["public.users"]).toBe("1\tjohn@x.com\n");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/lib/backup/storage.test.ts`
Expected: FAIL — cannot find module `storage`.

- [ ] **Step 3: Implement**

Create `src/lib/backup/storage.ts`:

```ts
import { gzipSync } from "node:zlib";
import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import type { BackupManifest } from "./manifest";

export type BackupPayload = { manifest: BackupManifest; tables: Record<string, string> };

/** gzip(JSON envelope). Dependency-light container — restore parses JSON then
 * COPYs each table string FROM STDIN. */
export function packBackup(payload: BackupPayload): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(payload), "utf8"));
}

export function objectKey(takenAt: string): string {
  return `user-settings/${takenAt}.json.gz`;
}

export async function getConnectionString(parameterName: string): Promise<string> {
  const ssm = new SSMClient({});
  const res = await ssm.send(
    new GetParameterCommand({ Name: parameterName, WithDecryption: true }),
  );
  const value = res.Parameter?.Value;
  if (!value) throw new Error(`SSM parameter ${parameterName} is empty`);
  return value;
}

export async function putBackup(opts: {
  bucket: string;
  payload: BackupPayload;
}): Promise<string> {
  const s3 = new S3Client({});
  const key = objectKey(opts.payload.manifest.taken_at);
  await s3.send(
    new PutObjectCommand({
      Bucket: opts.bucket,
      Key: key,
      Body: packBackup(opts.payload),
      ContentType: "application/gzip",
    }),
  );
  return key;
}

/** Heartbeat metric; the staleness alarm treats missing data as breaching. */
export async function emitHeartbeat(): Promise<void> {
  const cw = new CloudWatchClient({});
  await cw.send(
    new PutMetricDataCommand({
      Namespace: "stocktextalerts/Backup",
      MetricData: [{ MetricName: "BackupSuccess", Value: 1, Unit: "Count" }],
    }),
  );
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test -- tests/lib/backup/storage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/backup/storage.ts tests/lib/backup/storage.test.ts
git commit -m "feat(backup): SSM connection fetch, gzip+S3 put, heartbeat metric"
```

---

## Task 7: Lambda handler

**Files:**

- Create: `src/handlers/backup-user-settings.ts`

> Handler is thin glue over tested modules; verified by `check:ts` + the e2e build,
> not a unit test (matches the existing un-unit-tested handler pattern).

- [ ] **Step 1: Implement the handler**

Create `src/handlers/backup-user-settings.ts`:

```ts
import type { Context, ScheduledEvent } from "aws-lambda";
import { requireEnv } from "../lib/db/env";
import { createLogger } from "../lib/logging";
import { runWithRequestContext } from "../lib/logging/request-context";
import { exportSnapshot } from "../lib/backup/export";
import { emitHeartbeat, getConnectionString, putBackup } from "../lib/backup/storage";

export async function handler(event: ScheduledEvent, context: Context): Promise<void> {
  return runWithRequestContext(context.awsRequestId, async () => {
    const logger = createLogger({
      source: "lambda",
      function: "backup-user-settings",
      gitSha: process.env.GIT_SHA,
    });
    logger.info("Lambda invoke", {
      action: "lambda_invoke",
      eventId: event.id,
      eventTime: event.time,
    });

    const bucket = requireEnv("BACKUP_BUCKET");
    const ssmParam = requireEnv("BACKUP_CONNECTION_SSM_PARAM");

    const connectionString = await getConnectionString(ssmParam);
    const snapshot = await exportSnapshot({ connectionString });
    const key = await putBackup({ bucket, payload: snapshot });
    await emitHeartbeat();

    logger.info("Backup written", {
      action: "backup_written",
      key,
      rowCounts: snapshot.manifest.row_counts,
      schemaVersion: snapshot.manifest.schema_version,
    });
  });
}
```

- [ ] **Step 2: Verify it type-checks and the knip/biome gates pass**

Run: `npm run check:ts && npm run check:biome && npm run check:knip`
Expected: PASS. (If knip flags the handler as unused, it is referenced by `aws/template.yaml` in Task 8 — add that first if knip runs before Task 8, or run knip after Task 8.)

- [ ] **Step 3: Commit**

```bash
git add src/handlers/backup-user-settings.ts
git commit -m "feat(backup): user-settings backup Lambda handler"
```

---

## Task 8: SAM infra — function, bucket, schedule, IAM, alarms

> **AS-BUILT:** The template already had a `ProdBackupsBucket` — the Lambda reused it under the
> `user-settings/` prefix (with a prefix-scoped 30-day lifecycle rule) instead of creating the
> `BackupBucket` shown below. See the spec's "As-built notes". The function/schedule/IAM/alarm
> blocks below are otherwise accurate; the IAM `Resource` points at `ProdBackupsBucket.Arn`.

**Files:**

- Modify: `aws/template.yaml`

- [ ] **Step 1: Add parameter for the SSM connection param name**

Under `Parameters:` add:

```yaml
  BackupConnectionSsmParam:
    Type: String
    Default: /stocktextalerts/backup/connection-string
    Description: SSM SecureString param name holding the backup_readonly connection string
```

- [ ] **Step 2: Add the private S3 bucket with BPA, SSE-S3, 30-day lifecycle**

Under `Resources:` add:

```yaml
  BackupBucket:
    Type: AWS::S3::Bucket
    Properties:
      BucketName: !Sub "stocktextalerts-user-backups-${AWS::AccountId}"
      PublicAccessBlockConfiguration:
        BlockPublicAcls: true
        BlockPublicPolicy: true
        IgnorePublicAcls: true
        RestrictPublicBuckets: true
      BucketEncryption:
        ServerSideEncryptionConfiguration:
          - ServerSideEncryptionByDefault:
              SSEAlgorithm: AES256
      LifecycleConfiguration:
        Rules:
          - Id: expire-30-days
            Status: Enabled
            Prefix: user-settings/
            ExpirationInDays: 30

  BackupBucketDenyInsecure:
    Type: AWS::S3::BucketPolicy
    Properties:
      Bucket: !Ref BackupBucket
      PolicyDocument:
        Version: "2012-10-17"
        Statement:
          - Sid: DenyInsecureTransport
            Effect: Deny
            Principal: "*"
            Action: "s3:*"
            Resource:
              - !GetAtt BackupBucket.Arn
              - !Sub "${BackupBucket.Arn}/*"
            Condition:
              Bool:
                aws:SecureTransport: "false"
```

- [ ] **Step 3: Add the log group**

```yaml
  BackupUserSettingsLogGroup:
    Type: AWS::Logs::LogGroup
    Properties:
      RetentionInDays: 30
```

- [ ] **Step 4: Add the function (5×/day schedule, least-privilege IAM)**

```yaml
  BackupUserSettingsFunction:
    Type: AWS::Serverless::Function
    Metadata:
      BuildMethod: esbuild
      BuildProperties:
        Minify: false
        Format: cjs
        Target: node24
        Sourcemap: true
        EntryPoints:
          - backup-user-settings.ts
    Properties:
      FunctionName: stocktextalerts-backup-user-settings
      Handler: backup-user-settings.handler
      CodeUri: src/handlers
      Timeout: 120
      MemorySize: 256
      LoggingConfig:
        LogGroup: !Ref BackupUserSettingsLogGroup
      Environment:
        Variables:
          BACKUP_BUCKET: !Ref BackupBucket
          BACKUP_CONNECTION_SSM_PARAM: !Ref BackupConnectionSsmParam
      Policies:
        - Version: "2012-10-17"
          Statement:
            - Effect: Allow
              Action: s3:PutObject
              Resource: !Sub "${BackupBucket.Arn}/user-settings/*"
            - Effect: Allow
              Action: ssm:GetParameter
              Resource: !Sub "arn:aws:ssm:${AWS::Region}:${AWS::AccountId}:parameter${BackupConnectionSsmParam}"
            - Effect: Allow
              Action: kms:Decrypt
              Resource: !Sub "arn:aws:kms:${AWS::Region}:${AWS::AccountId}:alias/aws/ssm"
            - Effect: Allow
              Action: cloudwatch:PutMetricData
              Resource: "*"
      Events:
        FiveTimesDaily:
          Type: ScheduleV2
          Properties:
            # 02:00, 07:00, 12:00, 17:00, 22:00 UTC
            ScheduleExpression: "cron(0 2,7,12,17,22 * * ? *)"
            State: ENABLED
            RoleArn: !GetAtt StockTextAlertsSchedulerRole.Arn
```

> The `kms:Decrypt` on `alias/aws/ssm` covers SecureString decryption with the default SSM key. If the param is stored with a customer-managed key, point this at that key ARN instead.

- [ ] **Step 5: Add the two alarms (error + staleness heartbeat)**

```yaml
  BackupUserSettingsErrorAlarm:
    Type: AWS::CloudWatch::Alarm
    Properties:
      AlarmName: stocktextalerts-backup-user-settings-lambda-errors
      AlarmDescription: BackupUserSettingsFunction threw / timed out / OOMed
      Namespace: AWS/Lambda
      MetricName: Errors
      Dimensions:
        - Name: FunctionName
          Value: !Ref BackupUserSettingsFunction
      Statistic: Sum
      Period: 300
      EvaluationPeriods: 1
      Threshold: 1
      ComparisonOperator: GreaterThanOrEqualToThreshold
      TreatMissingData: notBreaching
      AlarmActions:
        - !Ref AlertTopicArn
      OKActions:
        - !Ref AlertTopicArn

  BackupUserSettingsStaleAlarm:
    Type: AWS::CloudWatch::Alarm
    Properties:
      AlarmName: stocktextalerts-backup-user-settings-stale
      AlarmDescription: No successful user-settings backup in the last 6 hours
      Namespace: stocktextalerts/Backup
      MetricName: BackupSuccess
      Statistic: Sum
      Period: 21600
      EvaluationPeriods: 1
      Threshold: 1
      ComparisonOperator: LessThanThreshold
      TreatMissingData: breaching
      AlarmActions:
        - !Ref AlertTopicArn
      OKActions:
        - !Ref AlertTopicArn
```

- [ ] **Step 6: Validate the template + YAML/knip gates**

Run: `npm run check:yaml && npm run check:knip && sam validate --template aws/template.yaml --lint`
Expected: PASS. (`sam validate` needs the SAM CLI; if unavailable locally, at minimum `check:yaml` must pass and the template is validated on the next `npm run deploy:aws`.)

- [ ] **Step 7: Commit**

```bash
git add aws/template.yaml
git commit -m "feat(backup): SAM bucket, 5x/day schedule, least-priv IAM, error+staleness alarms"
```

---

## Task 9: Restore script + runbook

**Files:**

- Create: `scripts/backup/restore.ts`
- Create: `docs/backups.md`
- Modify: `package.json` (add `backup:restore` script)

- [ ] **Step 1: Implement the restore script**

Create `scripts/backup/restore.ts`:

```ts
/**
 * Restore a user-settings backup object into a TARGET Postgres.
 * Schema must already exist in the target (run `npm run db:reset` for a scratch DB).
 *
 * Usage:
 *   node --env-file-if-exists=.env.local scripts/backup/restore.ts <path-to.json.gz> <target-DATABASE_URL>
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { Client } from "pg";
import { from as copyFrom } from "pg-copy-streams";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { BACKUP_TABLES } from "../../src/lib/backup/tables";
import type { BackupPayload } from "../../src/lib/backup/storage";

async function main() {
  const [, , file, targetUrl] = process.argv;
  if (!file || !targetUrl) throw new Error("usage: restore.ts <file.json.gz> <DATABASE_URL>");

  const payload = JSON.parse(gunzipSync(readFileSync(file)).toString("utf8")) as BackupPayload;

  const client = new Client({
    connectionString: targetUrl,
    ssl: targetUrl.includes("sslmode=") ? undefined : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const schemaRes = await client.query<{ schema_version: string }>(
      "select schema_version from public.app_metadata limit 1",
    );
    const target = schemaRes.rows[0]?.schema_version;
    if (target !== payload.manifest.schema_version) {
      throw new Error(
        `schema mismatch: backup=${payload.manifest.schema_version} target=${target}`,
      );
    }

    await client.query("BEGIN");
    // Restore child-before-parent reverse is unnecessary inside one txn with
    // deferred checks; we truncate then COPY in parent-first order.
    for (const table of [...BACKUP_TABLES].reverse()) {
      await client.query(`TRUNCATE ${table} CASCADE`);
    }
    for (const table of BACKUP_TABLES) {
      const text = payload.tables[table] ?? "";
      const ingest = client.query(copyFrom(`COPY ${table} FROM STDIN`));
      await pipeline(Readable.from([text]), ingest);
    }
    await client.query("COMMIT");

    process.stdout.write(`restored ${file} -> ${target}\n`);
    process.stdout.write(`${JSON.stringify(payload.manifest.row_counts)}\n`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
```

- [ ] **Step 2: Add the npm script**

In `package.json` `scripts`, add:

```json
"backup:restore": "node --env-file-if-exists=.env.local ./node_modules/.bin/tsx scripts/backup/restore.ts"
```

> **AS-BUILT:** must run via `tsx` (not bare `node`) — `package.json` is `"type": "module"`, so a
> `.ts` entrypoint run by `node` resolves as ESM and rejects the extensionless relative imports.

- [ ] **Step 3: Write the runbook**

Create `docs/backups.md`:

```markdown
# User-Settings Backups

Backs up 4 user-authored tables (`users`, `user_assets`, `price_targets`,
`scheduled_notifications`) 5×/day to a private S3 bucket. Design:
`docs/specs/2026-06-13-user-settings-backup-design.md`.

## One-time setup (human only — never via an agent)

1. Set the role password against production (human runbook; not in committed SQL):
   `ALTER ROLE backup_readonly LOGIN PASSWORD '<generated>';`
2. Build the pooler connection string (IPv4 transaction pooler, 6543, sslmode=require):
   `postgresql://backup_readonly:<pw>@aws-1-us-east-2.pooler.supabase.com:6543/postgres?sslmode=require`
3. Store it once in SSM SecureString:
   `aws ssm put-parameter --name /stocktextalerts/backup/connection-string --type SecureString --value '<conn>'`
4. Deploy infra: `npm run deploy:aws`.

## Restore (rehearse quarterly)

1. Download an object: `aws s3 cp s3://stocktextalerts-user-backups-<acct>/user-settings/<ts>.json.gz /tmp/b.json.gz`
2. Recreate schema in a scratch DB: `npm run db:reset`
3. Restore: `npm run backup:restore -- /tmp/b.json.gz "$DATABASE_URL"`
4. Verify printed row counts match the manifest and spot-check one user's settings.

The restore asserts the manifest `schema_version` matches the target; a mismatch aborts.
```

- [ ] **Step 4: Verify gates**

Run: `npm run check:ts && npm run check:biome && npm run check:md`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/backup/restore.ts docs/backups.md package.json
git commit -m "feat(backup): restore script + runbook"
```

---

## Task 10: Restore rehearsal — the completion gate

**Files:** none (verification only)

- [ ] **Step 1: Produce a real backup object locally**

Run a one-off invocation of `exportSnapshot` against local Supabase and pack it, e.g. via a scratch node script or `npm test -- tests/lib/backup/export.test.ts` plus a manual pack — then write a `.json.gz` to `/tmp`. (Or run the deployed Lambda once after Task 8 deploy and `aws s3 cp` the object down.)

- [ ] **Step 2: Restore into a freshly reset scratch DB**

Run:

```bash
npm run db:reset
npm run backup:restore -- /tmp/b.json.gz "$DATABASE_URL"
```

Expected: prints `restored …` and a row-counts JSON with no error; ROLLBACK not triggered.

- [ ] **Step 3: Verify integrity**

Run:

```bash
psql "$DATABASE_URL" -c "select count(*) from public.users;"
psql "$DATABASE_URL" -c "select id, email from public.users limit 3;"
```

Expected: counts equal the manifest `row_counts["public.users"]`; spot-checked rows look right; FK children (`user_assets`, `price_targets`, `scheduled_notifications`) restored without FK errors.

- [ ] **Step 4: Record the rehearsal**

Append a dated "Rehearsed restore on YYYY-MM-DD — N users restored OK" line to `docs/backups.md` and commit.

```bash
git add docs/backups.md
git commit -m "docs(backup): record first restore rehearsal"
```

---

## Self-Review

- **Spec coverage:** Task 2 → role/grants (AC#3); Tasks 3–5 → COPY-in-one-transaction export (AC#1,#2); Task 6 → storage/manifest/heartbeat (AC#1,#5); Task 7 → handler; Task 8 → bucket+BPA+SSE-S3+lifecycle+schedule+IAM+alarms (AC#1,#4,#5); Tasks 9–10 → restore + rehearsal (AC#6). Out-of-band password/SSM steps captured in `docs/backups.md` and the spec.
- **Type consistency:** `BackupManifest`/`BackupPayload`/`Snapshot`/`BACKUP_TABLES` are defined once and reused by export, storage, handler, and restore. `exportSnapshot({connectionString})`, `putBackup({bucket,payload})`, `getConnectionString(name)`, `emitHeartbeat()` signatures match across handler and tests.
- **Placeholder scan:** no TBD/"handle errors"/"similar to" — every code step is complete. The one deliberately manual element (role password + SSM value) is flagged as human-only per project policy, not an agent step.

## Execution Handoff

Plan complete and saved to `docs/plans/2026-06-13-user-settings-backup.md`. Two execution options:

1. **Subagent-Driven (recommended)** — one fresh subagent per task, review between tasks.
2. **Inline Execution** — execute tasks in this session with checkpoints.

Which approach?
