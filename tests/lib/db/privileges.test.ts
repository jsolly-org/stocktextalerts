import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectPrivilegeViolations } from "../../../scripts/db/check-privileges";
import {
	CLIENT_ROLES,
	ENFORCED_FUNCTIONS,
	executeRolesFor,
	type RoleName,
} from "../../../scripts/db/privilege-contract";

/**
 * Locks local (and CI) Supabase function grants to the explicit contract so the
 * environment fails on the same permission mistakes hosted production would:
 * missing `service_role` EXECUTE (the duplicate-SMS incident) and accidental
 * `anon`/`authenticated` exposure of server-only RPCs.
 *
 * This complements `npm run check:db-privileges` (same core logic via
 * `collectPrivilegeViolations`) by surfacing failures inside the normal test
 * run, where most permission-affecting migrations are exercised.
 */

function createDbClient(): Client {
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) {
		throw new Error("Missing DATABASE_URL");
	}
	return new Client({ connectionString: databaseUrl });
}

describe("Supabase function privileges match the explicit contract", () => {
	let client: Client;

	beforeAll(async () => {
		client = createDbClient();
		await client.connect();
	});

	afterAll(async () => {
		await client.end();
	});

	it("the full contract reports no violations (no missing/extra grants, no broad function defaults, no unclassified functions)", async () => {
		const { errors } = await collectPrivilegeViolations(client);
		expect(errors).toEqual([]);
	});

	it("default privileges no longer auto-grant EXECUTE on future functions to client roles", async () => {
		const { rows } = await client.query<{ grantee: string }>(`
			SELECT CASE WHEN (a).grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid((a).grantee) END AS grantee
			FROM pg_default_acl d
			JOIN pg_namespace n ON n.oid = d.defaclnamespace
			CROSS JOIN LATERAL aclexplode(d.defaclacl) AS a
			WHERE n.nspname = 'public'
			  AND d.defaclobjtype = 'f'
			  AND pg_get_userbyid(d.defaclrole) = 'postgres'
			  AND (a).privilege_type = 'EXECUTE'
		`);
		const grantees = rows.map((r) => r.grantee);
		expect(grantees).not.toContain("anon");
		expect(grantees).not.toContain("authenticated");
		expect(grantees).not.toContain("service_role");
		expect(grantees).not.toContain("PUBLIC");
	});

	it("default privileges no longer auto-grant access on future tables/sequences to client roles", async () => {
		const { rows } = await client.query<{ objtype: string; grantee: string }>(`
			SELECT d.defaclobjtype::text AS objtype,
			       CASE WHEN (a).grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid((a).grantee) END AS grantee
			FROM pg_default_acl d
			JOIN pg_namespace n ON n.oid = d.defaclnamespace
			CROSS JOIN LATERAL aclexplode(d.defaclacl) AS a
			WHERE n.nspname = 'public'
			  AND d.defaclobjtype IN ('r', 'S')
			  AND pg_get_userbyid(d.defaclrole) = 'postgres'
		`);
		const offending = rows.filter((r) =>
			["anon", "authenticated", "service_role", "PUBLIC"].includes(r.grantee),
		);
		expect(offending).toEqual([]);
	});

	it.each(
		ENFORCED_FUNCTIONS,
	)("$signature ($class) is executable by exactly its contracted roles", async (entry) => {
		const { signature } = entry;
		const { rows } = await client.query<{ oid: number }>(
			`
				SELECT p.oid::int AS oid
				FROM pg_proc p
				JOIN pg_namespace n ON n.oid = p.pronamespace
				WHERE n.nspname = 'public'
				  AND p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' = $1
				`,
			[signature],
		);
		expect(rows, `function not found: ${signature}`).toHaveLength(1);
		const oid = rows[0]?.oid as number;

		const expected = new Set<RoleName>(executeRolesFor(entry));
		for (const role of CLIENT_ROLES) {
			const { rows: privRows } = await client.query<{ ok: boolean }>(
				`SELECT has_function_privilege($1, $2::oid, 'EXECUTE') AS ok`,
				[role, oid],
			);
			expect(privRows[0]?.ok, `${role} EXECUTE on ${signature}`).toBe(expected.has(role));
		}
	});
});
