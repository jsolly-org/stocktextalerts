# Laptop deploy credential decoupling — stop the SSO prompt without weakening admin MFA

**Status:** Reviewed (adversarial review folded in — this session)
**Date:** 2026-06-21
**Scope:** `~/.aws/config` (machine-global), `shared-infra/aws/template.yaml` (the **shared** fleet
`agent-deploy` role — 6 services), `stocktextalerts/aws/deploy-web.sh` (Phase 3), plus doc updates.
**Driver:** deep-research report + live validation against account `730335616323` + 5-reviewer
adversarial verification.

---

## Spec

**Problem.** `aws sso login` re-prompts on (nearly) every `git push` to `main`. Root cause, validated
live: `~/.aws/config:42-44` — the scoped `fleet-deploy` profile assumes `agent-deploy` via
`source_profile = default`, and `default` is the `AdministratorAccess` SSO session. So the *frequent,
already-safe* code-deploy path is gated behind the *admin* login, and the only knob that silences the
prompt (the IdC access-portal session duration) is shared with the `delete-stack`-capable admin role.

**Goal.** Make code deploys stop prompting, **without** lengthening the MFA cadence on the admin/infra
path, and **without** a long-lived static secret on disk that can RCE the prod Lambda runtime.

**Non-goals.** Cloud CI (deliberately removed 2026-06-13/15 for credential hygiene + test fidelity).
Automating infra (`sam deploy`) — stays a human MFA'd step-up. **Cloud agents (Cursor) — deferred:**
this plan is local-machine-first; the standing `CursorCloudAgents` trust path is *removed* in Tier 2
and revisited only once the local model is perfected.

**Acceptance.**

1. `aws sts get-caller-identity --profile fleet-deploy` resolves **with no active admin SSO session**.
2. A `git push` to `main` completes the code deploy **without** an `aws sso login` prompt.
3. The admin path (`prod-admin`/`default`/`npm run deploy:aws`) still requires a fresh MFA'd SSO
   session, on a cadence independent of the deploy path.
4. A stolen deploy credential cannot escalate beyond `UpdateFunctionCode` on the fleet functions, and
   (Tier 3) cannot ship code the Signer profile didn't sign **and** cannot detach the signing config.
5. The shared-role change does not break the other 5 consumers (regression smoke test passes).

---

## Validated current state (live, 2026-06-21)

| Fact | Value | Source |
| --- | --- | --- |
| SSO config style | **Token-provider** (`[sso-session my-sso-session]`) — modern; silent refresh available | `~/.aws/config` |
| The coupling | `fleet-deploy` → `source_profile = default` → `AdministratorAccess` | `~/.aws/config:42-44` |
| IdC instance | `ssoins-6684a81ce4a80a8a`, store `d-9a670f09f4`, owner acct `541310242108`, region us-east-2 | `sso-admin list-instances` |
| Deploy account / region | `730335616323` / **us-east-1** (the Lambdas live here) | `sts get-caller-identity`, policy ARNs |
| `agent-deploy` trust (current) | `CursorCloudAgents` (standing cloud path — **removed in Tier 2**, local-first) + `LocalSsoAdmin` (`AWSReservedSSO_AdministratorAccess_*` only) | `iam get-role` |
| `agent-deploy` perms | `LambdaCodeOnly` (UpdateFunctionCode/GetFunction, 6 fleet ARN prefixes) + invoke `*-live-provider-check` + CFN describe + logs + SNS; **`DenyInfraMutation`** denies CFN/IAM/Lambda create-delete + **`UpdateFunctionConfiguration`** | `iam get-policy-version` |
| `signer:*` / CSC denied? | **No** — not in `DenyInfraMutation` (the Tier-3 gap is real) | same |
| Role max session | **3600s (1 h)** — creds re-minted hourly, silently, by the helper | `template.yaml` (`MaxSessionDuration`) |
| Roles Anywhere | **Empty** (0 anchors/profiles); CLI present | `rolesanywhere list-*` |
| Code signing | **None** (0 CSCs; 7 fns `CodeSigningConfigArn: null`); `signer` CLI present | `lambda list-code-signing-configs` |
| Deploy mechanism | Phase 3 `deploy_code()` ~ln 210-217 → `update-function-code --zip-file fileb://` | `aws/deploy-web.sh` |
| Audit substrate | shared-infra CloudTrail already multi-region, 730-day retention; logs `CreateSession` w/ cert subject | `shared-infra/template.yaml` |

**"Could we allowlist my IP?" — No (verified 3-0).** `aws:SourceIp` evaluates only **public** IPs, is
**absent** behind VPC endpoints, can **block AWS service principals**, and a home IP is dynamic. The
real machine-grounding is an **X.509 client cert** (Tier 2) — but see the honest hardware caveat below.

---

## Tier 1 — Extend the IdC access-portal session (stopgap; minutes; zero code)

**What.** IdC console, management account `541310242108` (region us-east-2, instance
`ssoins-6684a81ce4a80a8a`): Settings → Authentication → session settings → raise the **access-portal
sign-in session** from the 8 h default toward 7 days (max 90). This is the session `aws sso login`
establishes; in-between pushes silently re-mint the 1 h `agent-deploy` creds from the cached portal token.

**Effect.** `aws sso login` re-challenges ~weekly instead of ~daily.

**Security tradeoff (must accept).** The portal session is **shared** across all permission sets. It
does **not** make admin credentials "live a week" — each admin role session still expires ≤12 h — but
it **drops the re-MFA cadence**: admin can re-mint fresh sessions for up to the portal duration without
a new MFA challenge. That weakens the exact gate the May-2026 stack-deletion incident says to protect.
Acceptable **only as a stopgap** until Tier 2; then revert the portal session to short.

**Human step-up.** Console action in the management account — agent proposes, human executes (no public
CLI for the user-interactive session duration; confirmed console-only).

**Decision point.** If Tier 2 is imminent, **skip Tier 1** — don't weaken admin MFA for a few days of
convenience Tier 2 delivers permanently.

---

## Tier 2 — Decouple via IAM Roles Anywhere (the real fix; hours)

**What.** Give the laptop its own X.509 machine identity that assumes `agent-deploy` **directly**, no
admin SSO session in the chain. The admin path then keeps a short, MFA'd session of its own.

### ⚠️ The hardware-grounding correction (read before designing)

The original plan assumed the private key would live in the **macOS Secure Enclave, non-exportable**.
**The official `aws_signing_helper` does NOT support the Secure Enclave** (open feature request
[aws/rolesanywhere-credential-helper#45](https://github.com/aws/rolesanywhere-credential-helper/issues/45),
since Aug 2023; only an unsupported community fork). Its macOS path is **plain Keychain** via
`--cert-selector`. True hardware non-exportability is supported only for **PKCS#11 (YubiKey)** and
**TPM (Linux/Windows)**. Importing a `.pfx` via `security import` yields an **exportable** key — the
opposite of what we want. **Pick the key-protection option explicitly — this changes the threat model:**

| Option | Non-exportability | Helper support | Cost | Verdict |
| --- | --- | --- | --- | --- |
| **(a) Keychain EC key, `kSecAttrIsExtractable=false`, generated in-Keychain** (not imported) | Software-protected — a file copy can't trivially lift it, but a privileged local process / Keychain-unlock can | ✅ native (`--cert-selector`) | $0 | **Default** — simplest, what the helper actually does |
| **(b) YubiKey / PKCS#11** | ✅ real hardware — key never leaves the token; deploy needs the key touched/present | ✅ native (`--certificate pkcs11:...`) | ~$50 | Strongest; adds a physical dependency to every deploy |
| (c) Secure Enclave (community fork) | ✅ hardware | ❌ unsupported | $0 | Rejected — unsupported binary in the prod deploy path |

**This is a prerequisite decision, not an open question.** The recommendation: **start with (a)**, and
treat **(b)** as the upgrade if/when the live-process threat (below) matters enough to accept a YubiKey
touch on every push.

### Steps

1. **Self-signed root CA (free).** `openssl` root CA cert + key — **CONFIRMED sufficient** (Roles
   Anywhere accepts an external certificate bundle; AWS Private CA at ~$400/mo correctly rejected). CA
   cert: `basicConstraints=CA:true`, `keyUsage=keyCertSign,cRLSign`, SHA-256. End-entity:
   `keyUsage=digitalSignature`, `CA:false`. The **CA private key lives encrypted/offline** — needed
   only to issue/rotate end-entity certs and sign the CRL.
2. **Trust anchor** in `730335616323` / **us-east-1** (match the deploy/Lambda region — Roles Anywhere
   is regional; IdC's us-east-2 is irrelevant here): `aws rolesanywhere create-trust-anchor` with the
   CA cert as source bundle.
3. **Profile** → role: `aws rolesanywhere create-profile --role-arns
   arn:aws:iam::730335616323:role/agent-deploy` (optionally an inline session policy further narrowing
   to `lambda:UpdateFunctionCode` + the invoke).
4. **Trust-policy statement on `agent-deploy`** (`shared-infra/aws/template.yaml` → applied by a full
   SAM deploy, admin). **CONFIRMED shape:** principal `rolesanywhere.amazonaws.com`; actions
   `sts:AssumeRole`, `sts:TagSession`, `sts:SetSourceIdentity`; condition **`ArnEquals` on
   `aws:SourceArn` = the trust-anchor ARN**. **Strengthen (mn3):** also bind to the specific laptop
   cert with `StringEquals` on `aws:PrincipalTag/x509Subject/CN` so *any* cert under the CA can't
   assume the role — only ours. Keep `LocalSsoAdmin`. **This step only *adds* the Roles Anywhere
   statement** — the `CursorCloudAgents` removal is **owned by the companion scrub plan**
   (`dotagents/docs/plans/2026-06-21-cursor-cloud-agent-fleet-scrub.md` §4), an independent deletion in
   the same trust policy. Re-read the live trust policy first; if the Cursor trust is already gone, just
   add Roles Anywhere. After both land, the laptop cert + the human admin SSO path are the *only*
   principals that can assume `agent-deploy` (local-first; cloud agents deferred).
5. **End-entity cert** for the laptop, signed by the CA, key protected per the chosen option above.
6. **Install `aws_signing_helper`** (≥1.0.5 for Keychain; current 1.8.4). Rewire `~/.aws/config`:

   ```ini
   # fleet-deploy MUST hold ONLY credential_process (+region) — the process provider is
   # checked AFTER others; a leftover source_profile/sso_* causes inconsistent resolution.
   [profile fleet-deploy]
   credential_process = /opt/homebrew/bin/aws_signing_helper credential-process \
       --cert-selector Key=x509Subject,Value=CN=<laptop-cn> \
       --trust-anchor-arn arn:aws:rolesanywhere:us-east-1:730335616323:trust-anchor/<id> \
       --profile-arn       arn:aws:rolesanywhere:us-east-1:730335616323:profile/<id> \
       --role-arn          arn:aws:iam::730335616323:role/agent-deploy
   region = us-east-1
   ```

   - **`--cert-selector`, NOT `--certificate`** (which takes a file/PKCS#11 URI). The private key is
     **inferred** from the store; **omit `--private-key`**.
   - **Absolute path** to the helper — `credential_process` runs in the **non-interactive pre-push
     hook**, which doesn't source the shell PATH (same failure class as the mise/aws grounding at
     `deploy-web.sh:48-60`).
   - The Darwin binary is **signed but not notarized** → mark the helper **"always allow"** on the
     Keychain item, or macOS throws a per-use prompt that **blocks the unattended hook**.
   - mise is orthogonal (it only pins the `aws`/`sam` binaries; the helper is resolved by the aws
     binary internally). `~/.aws/config` is **machine-global** — one edit covers all worktrees + main;
     no `.worktreeinclude` entry needed.
7. **Edit the preflight error message** at `deploy-web.sh:137-140`. Keep the
   `sts get-caller-identity` check (it correctly exercises `credential_process`), but the "expired SSO
   token → `aws sso login`" text becomes **misleading** — a failure now means expired/revoked cert,
   locked Keychain, missing helper, or CRL revocation. Reword to credential-helper-aware guidance.
8. **Verify** acceptance #1 with the admin SSO session expired; #2 by an actual push.

**Effect.** `git push` authenticates by cert — **no `aws sso login`**. Revert Tier 1 and set the
portal session **short**, restoring strong admin MFA. Prompt solved *and* admin hardened.

### Threat model (corrected — do not overclaim)

- **The laptop cert becomes the *sole* standing deploy principal.** This plan **removes** the existing
  standing cloud principal (`CursorCloudAgents`) from `agent-deploy` (Tier 2 step 4), so after Tier 2
  the only ways to assume the role are the laptop cert and the human `AdministratorAccess` SSO path.
  That is the deliberate local-first posture: one machine, one auditable deploy identity, no no-MFA
  cloud path. (Cloud agents are deferred until the local model is perfected — re-add a hardened cloud
  principal, e.g. with an `ExternalId`, only when that work begins.)
- **At-rest: a genuine improvement.** Today `~/.aws/sso/cache` holds a plaintext bearer token that,
  copied off the machine, reaches *every* assigned role **including AdministratorAccess**. The cert
  (option a) is harder to lift and reaches **only** code-only `agent-deploy`. (Option b: can't be
  lifted at all.)
- **Live (laptop unlocked): NOT better than today.** `credential_process` is invoked by *any* tool
  reading the profile with **no per-call interaction** — a malicious local process gets free deploys
  while unlocked, exactly as it can exchange the SSO bearer token today. **"Strictly better than
  today" holds only on the at-rest axis.** Closing the live hole requires either **option (b) YubiKey
  touch-per-deploy** (breaks silent/unattended deploy — a real tradeoff) or **Tier 3 Option B**.
- **Decision:** accept the live-process equivalence (unattended deploy stays silent), or adopt YubiKey
  presence-gating (every push needs a touch). Default: accept it; the at-rest win + code-only scope is
  the value.

### Cert lifecycle & fail-closed (must specify — not an open question)

- **Validity:** end-entity cert short (e.g. 90 days); CA cert long (e.g. 5 years).
- **Rotation:** a `rotate-deploy-cert` script (re-issue end-entity from the CA, re-import to Keychain)
  plus a calendar/alarm reminder ahead of expiry. **Not** left to chance — an expired cert surfaces as an
  opaque mid-gate deploy failure otherwise.
- **Fail-closed UX:** extend the preflight to detect an expired/near-expiry cert and print "cert
  expired — run `rotate-deploy-cert`", so the failure is actionable, not cryptic.
- **Revocation:** CRL signed by the CA, imported via `aws rolesanywhere import-crl` — the procedure for
  a lost/compromised laptop. (CRL import is itself an infra step-up.)
- **Machine-swap:** the cert is single-machine; document the CA-issue procedure for a new/re-imaged
  laptop. With `CursorCloudAgents` removed (Tier 2), the laptop cert + the human admin SSO path are
  the only ways into `agent-deploy` — no cloud deploy path remains to reason about.

**Rollback.** Point `fleet-deploy` back at a `source_profile = default` profile (keep that SSO config
on a **separate** profile, never co-resident with `credential_process`). Delete anchor/profile; revoke
the cert.

---

## Tier 3 — Lambda code signing (RCE blast-radius containment; heaviest; optional)

A stolen `agent-deploy` cred can `UpdateFunctionCode` → arbitrary code in a process holding
`DATABASE_URL_PROD` + provider keys = RCE + secret exfil. Code signing (Enforce) makes
`UpdateFunctionCode` reject any artifact the approved Signer profile didn't sign. **All code-signing
semantics below were verified.**

### Steps

1. **Signer signing profile** — platform **`AWSLambda-SHA384-ECDSA`** — owned by a separate
   admin/security identity, not the deploy identity.
2. **Lambda `CodeSigningConfig`** referencing it with **`UntrustedArtifactOnDeployment: Enforce`**
   (the `Warn` default lets unsigned through with only a `SignatureValidationErrors` metric).
3. **Attach the CSC** to the 7 stocktextalerts functions (`CodeSigningConfigArn` on each
   `AWS::Serverless::Function`). Full SAM deploy. Non-retroactive — takes effect on next code update.
   **Precondition:** any Lambda **layers** must also be Signer-signed; container-image functions can't
   be signed (ours are zip-based — confirm no layers).
4. **Rewrite `deploy-web.sh` Phase 3.** The driver is *transport*, not an API rejection: a signed
   artifact **is an S3 object**, so a CSC'd function must be updated via `--s3-bucket/--s3-key`. New
   `deploy_code()`: zip → upload to an S3 staging bucket → `aws signer start-signing-job` → poll
   `aws signer describe-signing-job` (no built-in waiter) → `aws lambda update-function-code
   --s3-bucket <signed> --s3-key <key>`. **Hard requirements:** the Signer **source bucket needs
   versioning enabled**; source bucket, destination bucket, and signing profile must be **same
   region** (us-east-1); signing **fails on empty/already-signed/malformed** zips.
   - **Preserve** the Phase-1-build-first invariant (`:159-164`) and the **2-arg `deploy_code
     <LogicalId> <physical-name>` signature** — the `check:deploy-functions` gate (`:41`) regex-matches
     it; changing the signature breaks the gate.
   - **Surface `LastUpdateStatusReason`** on a failed `function-updated-v2` wait so an operator can
     distinguish "bad signature" from "bad bundle."
   - Dep-grounding: `aws signer` is an `aws` subcommand (covered by `command -v aws` at `:123`); **do
     not** add `command -v signer` (never matches). Just keep the calls in the guarded `aws/*.sh` file.
5. **Close the authority-separation gap precisely** (`DenyInfraMutation`, shared role). The **biggest
   bypass is CSC detach** — deny exactly: `lambda:CreateCodeSigningConfig`,
   `lambda:UpdateCodeSigningConfig`, `lambda:DeleteCodeSigningConfig`,
   **`lambda:PutFunctionCodeSigningConfig`**, **`lambda:DeleteFunctionCodeSigningConfig`** (the
   attach/detach levers), plus Signer mutators `signer:PutSigningProfile`, `signer:RevokeSignature`,
   `signer:Add/RemoveProfilePermission` (and `signer:StartSigningJob` **if** Option B). **Allow** the
   `Get*` reads the verify path needs — do **not** use a loose `lambda:*CodeSigningConfig*` wildcard
   (it would also block `GetFunctionCodeSigningConfig`).

### The load-bearing nuance (verified sound)

In an automated laptop deploy the cred must *trigger* signing — but a cred that can submit arbitrary
input to the approved profile (`signer:StartSigningJob`) **can sign its own malware**, so code signing
then gives **no RCE protection against that cred**.

- **Option A (cheap):** deploy cred holds `StartSigningJob`. Buys **integrity + provenance + audit +
  revocation** — *not* RCE containment.
- **Option B (real containment):** signing runs in an **S3-upload-triggered Lambda**; deploy cred has
  **no** signer perms, only `update-function-code` from the signed bucket. **Caveat (verified):** Option
  B only works if the signer gates **input provenance** — if it auto-signs anything in a
  deploy-cred-writable staging bucket, it's "Option A wearing a Lambda costume."

**Honest value:** for a solo laptop that builds *and* signs, Tier 3 (Option A) is integrity/provenance,
not containment. **Lowest-ROI tier — last/optional.** Full RCE containment needs Option B's separated,
provenance-gated signer. **Cost is trivial:** Roles Anywhere has no per-session charge; **Signer +
Lambda code signing are free**; only negligible S3 staging storage is new.

**Rollback.** Detach CSCs (admin), revert `deploy-web.sh` Phase 3 to `--zip-file`.

---

## Sequencing & recommendation

```text
Tier 1 (minutes)  → immediate relief; TEMPORARILY weakens admin re-MFA cadence
   ↓ within days
Tier 2 (hours)    → prompt gone for good; REVERT Tier 1, restore short admin MFA   ← the fix
   ↓ optional, later
Tier 3 (heaviest) → integrity/provenance now; full RCE containment only with Option B
```

- **Minimum to solve the stated problem:** Tier 2 (skip Tier 1 if Tier 2 is imminent).
- **Stop after Tier 2** unless you want RCE-hardening; Tier 3's full value needs Option B.

## Cross-repo / cross-account touch list

| Change | Where | Apply via |
| --- | --- | --- |
| Portal session duration (T1) | IdC console, acct `541310242108` | Human, console |
| `fleet-deploy` → `credential_process` (T2) | `~/.aws/config` (machine-global) | Local edit |
| Trust anchor + profile + CRL (T2) | acct `730335616323`, us-east-1 | **Human step-up** — `aws rolesanywhere create-*` (see note) |
| `agent-deploy` trust: **add** Roles Anywhere stmt + **remove** `CursorCloudAgents` stmt (T2); `DenyInfraMutation` deny additions (T3) | `shared-infra/aws/template.yaml` (**shared, 6 services**) | `npm run deploy:aws` (admin SAM) |
| Preflight message + Phase-3 S3/signing rewrite | `stocktextalerts/aws/deploy-web.sh` | Code change |
| Signing profile + CSC + attach (T3) | `stocktextalerts/aws/template.yaml` | `npm run deploy:aws` |
| **Doc updates (T2)** | `dotagents/rules/agent-cloud-access.md` (AWS section — drop the Cursor-cloud assume path), `stocktextalerts/CLAUDE.md` (AWS IAM + Deploy), `shared-infra/template.yaml` trust-policy comments (remove "Cursor cloud" + "any AdministratorAccess SSO session") | same integration as T2 |
| **Regression smoke test (B2)** | after any shared-role SAM deploy: code-deploy one other consumer (e.g. misc-notifications) | manual verify |
| **Standing wiring check (mn12)** | `doctor-agents.sh` or a stocktextalerts preflight: helper on PATH, `fleet-deploy` resolves w/o SSO, cert not within N days of expiry | new check |

**Step-up note (M8).** `aws rolesanywhere create-trust-anchor/create-profile/import-crl` stand up a new
standing auth path into prod but are **not** in `agent.json`'s deny list and have **no `block-*`
guard**. They must be **human-executed under step-up** (agent only emits the exact command). Consider
adding `aws rolesanywhere create-*`/`import-crl` to the agent deny list or a guard so an agent can't
stand up an alternate trust path unsupervised.

## Open questions (genuinely open — the SE/rotation ones are now resolved above)

1. **Option (a) Keychain vs (b) YubiKey** — accept the live-process equivalence, or pay a touch-per-push
   for real hardware non-exportability + presence-gating? (Default: (a) now, (b) later if needed.)
2. **Tier 3 at all, and Option A vs B** — is integrity/provenance enough, or build the separated
   provenance-gated signer for true RCE containment?
3. **Anchor-repo for this plan** — lives in `stocktextalerts` (primary, live pain) but the role is
   `shared-infra`'s and fleet-wide. Confirm home or split the shared-infra parts into a shared-infra plan.

---

### Review provenance

Core architecture (Roles Anywhere + self-signed-CA trust anchor + `credential_process`) verified sound
by a 5-reviewer adversarial pass; all load-bearing AWS facts (trust-policy shape, code-signing
semantics, signer/deploy separation, validated-state table, step-up classification) confirmed. The
Secure-Enclave assumption was the one blocker — corrected above.
