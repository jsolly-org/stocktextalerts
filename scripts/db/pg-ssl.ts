import { readFileSync } from "node:fs";
import { isLocalHost } from "./is-local-host";

/**
 * ssl config for a node-postgres Client, by connection target.
 *
 * Local Postgres has no TLS → undefined. Non-local (hosted Supabase) →
 * verify-full semantics: chain + hostname validation against the pinned
 * "Supabase Root 2021 CA" (supabase-prod-ca-2021.crt, extracted from the
 * pooler's served chain on 2026-06-10; the dashboard's prod-ca-2021.crt is
 * the authoritative copy). Hosted Supabase chains to this private CA, so system-CA
 * validation (`ssl: true`) can never succeed. `rejectUnauthorized` stays at
 * its default `true` — only `ca` is needed.
 *
 * The root expires 2031-04-26. If Supabase rotates the CA early, this fails
 * loudly with a certificate validation error — re-download the CA from
 * Dashboard → Project Settings → Database → SSL Configuration.
 */
export function pgSsl(connectionString: string): { ca: string } | undefined {
	if (isLocalHost(connectionString)) return undefined;
	// node-postgres merges SSL connection-string parameters OVER the programmatic
	// ssl object, silently discarding the pinned CA — verified: `?ssl=0` disables
	// TLS entirely (plaintext + prod password on the wire), `?sslrootcert=…`
	// swaps the CA for an arbitrary file, `?sslmode=`/`?ssl=true` drop the pin for
	// system-CA validation. The only correct SSL config for a pinned Supabase
	// target is the `{ ca }` below, so reject any string that smuggles one in.
	// Case-sensitive: node-postgres only honors lowercase param keys, so an
	// uppercase `?SSLMODE=` is inert and the pin still stands.
	if (/[?&]ssl(mode|cert|key|rootcert|password)?=/.test(connectionString)) {
		throw new Error(
			"pgSsl: connection string carries an SSL parameter (ssl/sslmode/sslrootcert/sslcert/sslkey/sslpassword) that node-postgres lets override the pinned-CA ssl config — remove it from the URL",
		);
	}
	return { ca: readFileSync(new URL("./supabase-prod-ca-2021.crt", import.meta.url), "utf8") };
}
