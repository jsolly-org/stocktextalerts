/**
 * scripts/db/dump-permissions.ts — read-only permission-structure dump and
 * local-vs-production parity audit. Runs only catalog SELECTs; never mutates.
 *
 * Modes:
 *   tsx scripts/db/dump-permissions.ts "<connection-string>"
 *     Dump one database's permission structure as sorted, normalized lines
 *     (schema/default ACLs, relation/column/function ACLs, RLS flags,
 *     policies, owners, role memberships, applied migrations).
 *
 *   tsx scripts/db/dump-permissions.ts --diff-prod
 *     Dump local (DATABASE_URL) and production (DATABASE_URL_PROD), diff the
 *     two, filter the accepted-noise rules below, and exit 1 on residual
 *     drift. This is `npm run audit:db-parity`.
 *
 * Accepted noise (cannot be fixed by a postgres-run migration; semantically
 * inert for app objects — see docs/local-supabase.md). Each rule is scoped to
 * the diff side it originates on — `isLocalOnlyNoise` filters local-only lines,
 * `isProdOnlyNoise` filters prod-only lines — so a noise rule for one side can
 * never swallow a genuine one-sided grant on the other:
 *   - `default_acl|supabase_admin|...` rows: the local Supabase image ships
 *     broad supabase_admin-owned default ACLs that hosted prod lacks. App
 *     migrations create objects as `postgres`, so these never govern app
 *     objects.
 *   - pg_trgm extension function grants: owned by `supabase_admin`, so
 *     `postgres` cannot revoke the broad grants the local image stamped.
 *     Both environments have implicit PUBLIC EXECUTE on them regardless.
 *   - `schema|public|pg_database_owner|...` / postgres CREATE on the schema:
 *     local owns `public` via pg_database_owner (stock PG layout), prod via
 *     `postgres` directly. Equivalent effective privileges.
 */
import { Client } from "pg";
import { pgSsl } from "./pg-ssl";

const QUERIES: string[] = [
	// 1. public schema ACL (NULL expanded to implicit default)
	`SELECT 'schema|' || n.nspname || '|' ||
	        CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || '|' ||
	        string_agg(a.privilege_type, ',' ORDER BY a.privilege_type) AS line
	 FROM pg_namespace n
	 LEFT JOIN LATERAL aclexplode(coalesce(n.nspacl, acldefault('n'::"char", n.nspowner))) a ON true
	 WHERE n.nspname = 'public'
	 GROUP BY n.nspname, a.grantee`,

	// 2. Default privileges (ALTER DEFAULT PRIVILEGES), all schemas
	`SELECT 'default_acl|' || pg_get_userbyid(d.defaclrole) || '|' ||
	        coalesce(n.nspname, '<all-schemas>') || '|' || d.defaclobjtype::text || '|' ||
	        CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || '|' ||
	        string_agg(a.privilege_type, ',' ORDER BY a.privilege_type) AS line
	 FROM pg_default_acl d
	 LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
	 LEFT JOIN LATERAL aclexplode(d.defaclacl) a ON true
	 GROUP BY d.oid, d.defaclrole, n.nspname, d.defaclobjtype, a.grantee`,

	// 3. Relation ACLs in public (tables/views/matviews/sequences/partitions)
	`SELECT 'rel|' || c.relkind::text || '|' || n.nspname || '.' || c.relname || '|' ||
	        CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || '|' ||
	        string_agg(a.privilege_type, ',' ORDER BY a.privilege_type) AS line
	 FROM pg_class c
	 JOIN pg_namespace n ON n.oid = c.relnamespace
	 LEFT JOIN LATERAL aclexplode(coalesce(c.relacl,
	   acldefault(CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END::"char", c.relowner))) a ON true
	 WHERE n.nspname = 'public' AND c.relkind IN ('r','v','m','S','p','f')
	 GROUP BY c.relkind, n.nspname, c.relname, a.grantee`,

	// 4. Column-level ACLs in public
	`SELECT 'col|' || n.nspname || '.' || c.relname || '.' || att.attname || '|' ||
	        CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || '|' ||
	        string_agg(a.privilege_type, ',' ORDER BY a.privilege_type) AS line
	 FROM pg_attribute att
	 JOIN pg_class c ON c.oid = att.attrelid
	 JOIN pg_namespace n ON n.oid = c.relnamespace
	 LEFT JOIN LATERAL aclexplode(att.attacl) a ON true
	 WHERE n.nspname = 'public' AND att.attacl IS NOT NULL AND NOT att.attisdropped
	 GROUP BY n.nspname, c.relname, att.attname, a.grantee`,

	// 5. Function ACLs in public (full identity signature)
	`SELECT 'func|' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')|' ||
	        CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || '|' ||
	        string_agg(a.privilege_type, ',' ORDER BY a.privilege_type) AS line
	 FROM pg_proc p
	 JOIN pg_namespace n ON n.oid = p.pronamespace
	 LEFT JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f'::"char", p.proowner))) a ON true
	 WHERE n.nspname = 'public'
	 GROUP BY p.oid, a.grantee`,

	// 6. Function owner + SECURITY DEFINER flag
	`SELECT 'funcdef|' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')|owner=' ||
	        pg_get_userbyid(p.proowner) || '|secdef=' || p.prosecdef AS line
	 FROM pg_proc p
	 JOIN pg_namespace n ON n.oid = p.pronamespace
	 WHERE n.nspname = 'public'`,

	// 7. RLS enabled/forced flags
	`SELECT 'rls|' || n.nspname || '.' || c.relname || '|enabled=' || c.relrowsecurity ||
	        '|forced=' || c.relforcerowsecurity AS line
	 FROM pg_class c
	 JOIN pg_namespace n ON n.oid = c.relnamespace
	 WHERE n.nspname = 'public' AND c.relkind IN ('r','p')`,

	// 8. RLS policies
	`SELECT 'policy|' || schemaname || '.' || tablename || '|' || policyname || '|' ||
	        permissive || '|' || array_to_string(roles, ',') || '|' || cmd || '|qual=' ||
	        coalesce(qual, '<none>') || '|check=' || coalesce(with_check, '<none>') AS line
	 FROM pg_policies WHERE schemaname = 'public'`,

	// 9. Relation owners in public
	`SELECT 'owner|' || n.nspname || '.' || c.relname || '|' || pg_get_userbyid(c.relowner) AS line
	 FROM pg_class c
	 JOIN pg_namespace n ON n.oid = c.relnamespace
	 WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S')`,

	// 10. App-role memberships
	`SELECT 'rolemember|' || m.rolname || '|member_of|' || g.rolname AS line
	 FROM pg_auth_members am
	 JOIN pg_roles m ON m.oid = am.member
	 JOIN pg_roles g ON g.oid = am.roleid
	 WHERE m.rolname IN ('anon','authenticated','service_role','authenticator')
	    OR g.rolname IN ('anon','authenticated','service_role')`,

	// 11. Applied migration versions (parity precondition for the whole diff)
	`SELECT 'migration|' || version AS line
	 FROM supabase_migrations.schema_migrations`,
];

const PG_TRGM_FUNCTIONS = [
	"gin_extract_query_trgm",
	"gin_extract_value_trgm",
	"gin_trgm_consistent",
	"gin_trgm_triconsistent",
	"gtrgm_compress",
	"gtrgm_consistent",
	"gtrgm_decompress",
	"gtrgm_distance",
	"gtrgm_in",
	"gtrgm_options",
	"gtrgm_out",
	"gtrgm_penalty",
	"gtrgm_picksplit",
	"gtrgm_same",
	"gtrgm_union",
	"set_limit",
	"show_limit",
	"show_trgm",
	"similarity",
	"similarity_dist",
	"similarity_op",
	"strict_word_similarity",
	"strict_word_similarity_commutator_op",
	"strict_word_similarity_dist_commutator_op",
	"strict_word_similarity_dist_op",
	"strict_word_similarity_op",
	"word_similarity",
	"word_similarity_commutator_op",
	"word_similarity_dist_commutator_op",
	"word_similarity_dist_op",
	"word_similarity_op",
];

// Accepted-noise rules are scoped to the side they are documented for. A rule
// must only filter the diff side it actually originates on — applying a
// local-image rule to prodOnly (or vice versa) could silently swallow a genuine
// one-sided grant that happens to match the prefix, a false-negative in the one
// gate built to catch privilege drift.

// LOCAL-image artifacts: present locally, absent in hosted prod (see header).
// `schema|public|postgres|USAGE` is the local half of the public-schema
// ownership equivalence: local holds CREATE via `pg_database_owner`, so the
// `postgres` grantee line carries USAGE only.
function isLocalOnlyNoise(line: string): boolean {
	if (line.startsWith("default_acl|supabase_admin|")) return true;
	if (line.startsWith("schema|public|pg_database_owner|")) return true;
	if (line === "schema|public|postgres|USAGE") return true;
	if (line.startsWith("func|")) {
		const name = line.slice("func|".length).split("(")[0] ?? "";
		if (PG_TRGM_FUNCTIONS.includes(name)) return true;
	}
	return false;
}

// PROD-side artifact: the prod half of the same equivalence — hosted prod owns
// `public` via `postgres` directly, so the `postgres` grantee line carries
// CREATE,USAGE. Exact-match (not prefix) so a genuine prod-only grant can't hide
// behind it.
function isProdOnlyNoise(line: string): boolean {
	return line === "schema|public|postgres|CREATE,USAGE";
}

async function dump(connectionString: string): Promise<string[]> {
	const client = new Client({
		connectionString,
		statement_timeout: 15_000,
		connectionTimeoutMillis: 15_000,
		ssl: pgSsl(connectionString),
	});
	await client.connect();
	try {
		await client.query("SET default_transaction_read_only = on");
		const lines: string[] = [];
		for (const sql of QUERIES) {
			const { rows } = await client.query<{ line: string }>(sql);
			for (const row of rows) lines.push(row.line);
		}
		lines.sort();
		return lines;
	} finally {
		await client.end();
	}
}

async function diffProd(): Promise<void> {
	const localUrl = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
	const prodUrl = process.env.DATABASE_URL_PROD;
	if (!prodUrl) {
		process.stderr.write("audit:db-parity — missing DATABASE_URL_PROD in env (.env.local)\n");
		process.exitCode = 1;
		return;
	}

	const [localLines, prodLines] = await Promise.all([dump(localUrl), dump(prodUrl)]);
	const localSet = new Set(localLines);
	const prodSet = new Set(prodLines);

	const localOnly = localLines.filter((line) => !prodSet.has(line) && !isLocalOnlyNoise(line));
	const prodOnly = prodLines.filter((line) => !localSet.has(line) && !isProdOnlyNoise(line));

	if (localOnly.length === 0 && prodOnly.length === 0) {
		process.stdout.write(
			`audit:db-parity — ok: local matches production (${localLines.length} local / ${prodLines.length} prod lines, accepted-noise filtered)\n`,
		);
		return;
	}

	process.stdout.write("audit:db-parity — DRIFT FOUND\n");
	for (const line of localOnly) process.stdout.write(`  local-only: ${line}\n`);
	for (const line of prodOnly) process.stdout.write(`  prod-only:  ${line}\n`);
	process.exitCode = 1;
}

async function main(): Promise<void> {
	const arg = process.argv[2];
	if (arg === "--diff-prod") {
		await diffProd();
		return;
	}
	if (!arg) {
		process.stderr.write(
			"usage: tsx scripts/db/dump-permissions.ts <connection-string> | --diff-prod\n",
		);
		process.exitCode = 1;
		return;
	}
	const lines = await dump(arg);
	process.stdout.write(`${lines.join("\n")}\n`);
}

main().catch((err) => {
	process.stderr.write(`${String(err instanceof Error ? err.stack : err)}\n`);
	process.exitCode = 1;
});
