import { X509Certificate } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pgSsl } from "../../scripts/db/pg-ssl";

const PROD_POOLER =
	"postgresql://postgres.japesagairjvvuebzpvr:secret@aws-1-us-east-2.pooler.supabase.com:6543/postgres";

describe("Dev tooling connects to local and production Postgres with the right TLS posture", () => {
	it("skips SSL for the local Supabase stack, which serves no TLS", () => {
		// Covers the hosts this repo's dev/CI actually uses (Podman maps to
		// host.docker.internal; ::1 exercises the IPv6 bracket-stripping branch).
		expect(pgSsl("postgresql://postgres:postgres@127.0.0.1:54322/postgres")).toBeUndefined();
		expect(pgSsl("postgresql://postgres:postgres@localhost:54322/postgres")).toBeUndefined();
		expect(
			pgSsl("postgresql://postgres:postgres@host.docker.internal:54322/postgres"),
		).toBeUndefined();
		expect(pgSsl("postgresql://postgres:postgres@[::1]:54322/postgres")).toBeUndefined();
	});

	it("pins the Supabase Root 2021 CA with full validation for the production pooler", () => {
		const ssl = pgSsl(PROD_POOLER);
		expect(ssl).toBeDefined();
		// Pin the actual trust anchor, not merely "some PEM" — a wrong/missing cert
		// would let prod TLS silently fail at runtime while a `BEGIN CERTIFICATE`
		// substring check stayed green. Parsing also proves the cert is usable.
		const cert = new X509Certificate(ssl?.ca ?? "");
		expect(cert.subject).toContain("Supabase Root 2021 CA");
		// rejectUnauthorized must stay at its default (true) — setting it false
		// alongside `ca` would silently disable the validation the pin exists for.
		expect(ssl).not.toHaveProperty("rejectUnauthorized");
	});

	it("refuses connection strings whose SSL params would override the pinned CA", () => {
		// node-postgres merges these over the programmatic ssl object: ?ssl=0
		// disables TLS entirely, ?sslrootcert swaps the CA, ?sslmode drops the pin.
		// The realistic pooler shape carries other params first (&sslmode=).
		const overrideMatch = /override the pinned-CA ssl config/;
		expect(() => pgSsl(`${PROD_POOLER}?sslmode=require`)).toThrow(overrideMatch);
		expect(() => pgSsl(`${PROD_POOLER}?pgbouncer=true&sslmode=require`)).toThrow(overrideMatch);
		expect(() => pgSsl(`${PROD_POOLER}?ssl=0`)).toThrow(overrideMatch);
		expect(() => pgSsl(`${PROD_POOLER}?sslrootcert=/etc/passwd`)).toThrow(overrideMatch);
	});
});
