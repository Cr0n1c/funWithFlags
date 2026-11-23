# funwithflags-api

## Release notes: Hello World introductory flag

The built-in catalog now includes **Hello World** (`hello-world`), an Intro
challenge worth **5 points**. It directs players to `help`, whose documented
`submit hello_world` example uses the normal authenticated submission path.
Points are awarded once per player and once per group.

Deploying this code does **not** populate production challenge data. In **each
environment**, an authorized, SAML-authenticated `funwithflags-admins` member must
run `import_challenges`, review the missing-challenge preview (including Hello
World), and explicitly confirm the import. Supply original words only if the
preview also includes missing hash puzzles. No startup seeding or direct database
edits are needed or authorized by this release.

The existing import checks metadata and flag collisions, hashes answers, and
commits atomically. A fresh preview after import omits Hello World; repeating
the import does not duplicate it or rewrite existing solve/group awards. A stale
preview or a conflicting existing challenge is rejected: preview again, and
seek administrator review for conflicts rather than overwriting data.

## Okta SAML setup and rollout gate

Development and production are separate trust boundaries. Configure the same
variable names in each environment scope; do not invent prefixes such as `DEV_`
or `PROD_`, and do not copy values between scopes. No provider configuration is
fabricated. Missing configuration produces a safe login error and metadata HTTP
503, rather than a fallback to another sign-in method.

Runtime mode is resolved as follows:

- `ENVIRONMENT` accepts only `development`, `production`, or `test`.
- If `ENVIRONMENT` is unset, `NODE_ENV` accepts the same values and supplies the
  mode.
- Conflicting signals are rejected. Invalid `NODE_ENV` or `ENVIRONMENT`
  values are also rejected.
- With both signals absent, a standalone process defaults to development.
- Production must set `ENVIRONMENT=production` explicitly.

The launcher (`run_server.py`) requires `APP_BASE_URL` to be a public HTTPS origin
and never infers it. Settings additionally validates this in production and rejects
localhost and loopback origins. The launcher always forces Secure cookies
and disables startup migrations and seeding.

Configure these values independently in every applicable environment scope:

- `APP_BASE_URL`: the public HTTPS UI origin.
- `SAML_SP_ENTITY_ID`: an explicit unique SP audience/entity ID for that environment.
- `SAML_ACS_URL`: exactly `APP_BASE_URL` + `/api/auth/saml/acs`.
- `SAML_IDP_ENTITY_ID`: exact trusted Okta issuer from administrator-provided metadata.
- `SAML_IDP_SSO_URL`: trusted HTTPS Okta SAML sign-on endpoint.
- `SAML_IDP_CERT`: trusted PEM signing certificate from the administrator.
- `SAML_IDP_ROLLOVER_CERT`: optional second trusted signing certificate during rotation.
- `SAML_SP_CERT` and `SAML_SP_PRIVATE_KEY`: optional paired SP signing configuration;
  use Secrets for private keys. Requests are signed only when both are configured.
- `SAML_ADMIN_SUBJECTS`: explicitly approved stable NameID values, comma-separated;
  empty by default. Never use department, level, email or groups to grant admin access.
- `SAML_REQUIRED_ATTRIBUTES`: administrator-approved comma-separated subset of
  the six profile attributes below. Empty by default until mandatory fields are
  confirmed; absent optional values are stored as null, never fabricated.

For example, a synthetic development scope could use
`APP_BASE_URL=https://flags-dev.example.test`,
`SAML_SP_ENTITY_ID=https://flags-dev.example.test/saml`, and
`SAML_ACS_URL=https://flags-dev.example.test/api/auth/saml/acs`; a synthetic
production scope could use the corresponding `https://flags.example.test`
values. Each scope still uses the unprefixed names above and its own
administrator-supplied IdP issuer, SSO URL, and certificate.

IdP signing certificates are public trust material, not secrets.
By contrast, `SAML_SP_PRIVATE_KEY`, `SESSION_SECRET`, `FLAG_HASH_SECRET`, and
other credentials are sensitive and belong in the matching environment's
Secrets. `SAML_SP_CERT` is public, but its paired private key is not. This
documentation does not authorize moving, replacing, or otherwise changing any
current trust material.

Obtain issuer, SSO URL, signing certificate, Entity ID/audience, ACS URL, NameID,
and attribute details from the IdP administrators. Development and production
must use distinct Okta app registrations. Active trust, including
`SAML_IDP_ROLLOVER_CERT`, may contain certificates only for the same IdP
registration in that environment; the opposite environment's certificate is
not a rollover certificate.

In Okta configure **both response and assertion signing**, SHA-256 or stronger,
HTTP-POST ACS binding, and **persistent NameID** backed by an immutable user ID.
Provide six single-valued attribute statements using the confirmed Okta names:
`email`, `firstname`, `lastname`, `departmentparent`, `departmentleaf`, `level`.
The API maps these to `email`, `first_name`, `last_name`, `department_parent`,
`department_leaf`, and `level`, respectively. `SAML_REQUIRED_ATTRIBUTES` uses
these API names, not the Okta source names.
Confirm their actual Okta profile-field expressions with the administrator.
The application never guesses a department hierarchy. `level` is a string.
Limits: email 320 characters, first/last name and level 128, department fields 255.
Multiple values, control characters and oversized attributes fail authentication.
Only validated values are stored; no raw assertions are retained. Private profile
attributes appear only in the authenticated user's `/api/auth/me`, never leaderboard.
The optional multi-valued `groups` attribute is stored only after SAML validation
and displayed by the authenticated user's `groups` command. Up to 200 values of
255 characters each are accepted; control/format characters are rejected, whitespace
is trimmed, and duplicates are removed. Memberships are replaced on each login
(cleared when omitted) and never grant admin access.

SP metadata: `GET /api/auth/saml/metadata`. The explicit sign-in button navigates
the same window to `GET /api/auth/login`. The callback returns to the app, which
checks its session once; failures require a manual retry, not an automatic loop. The
browser transaction cookie is Secure/HttpOnly/SameSite=None, scoped only to the
ACS path and expires after ten minutes. Application cookies retain Lax by default.
Cross-site ACS POSTs must reach the backend through any deployment privacy gate.
Do not exempt validation or remove browser binding to work around that gate.
Logout clears only this app's session, not the user's global Okta session.

## Schema and account migration

The schema is created by the single initial Alembic revision, `0001`; there are no
incremental migrations. No startup migrations are enabled. Use the approved migration
process; do not migrate production automatically. Verify committed schema from
another connection, not just Alembic command output.

JIT accounts use issuer + persistent subject, not email. First valid login creates
a player; later logins refresh profile values without changing scores. DB uniqueness
and savepoints protect concurrent first logins. Disabled accounts remain blocked.
Accounts are issuer-qualified, so even matching subjects from the distinct
development and production registrations are never linked automatically.
All pre-SAML session audiences are invalid, including cookies with a renamed key.
Expired request records are removed when starting another login. Assertion replay
hashes are retained indefinitely (no raw subject or assertion); plan retention review
before introducing cleanup that could weaken replay protection.

For an approved existing-account mapping, use the local administrative command
`python -m app.cli link-saml /secure/path/reviewed-mapping.json`, after Security review,
before the person's first Okta login. This is not a public API. The JSON must contain
exactly `user_id` (integer), `previous_subject` (exact existing stored identity),
`issuer` (configured trusted issuer), `subject` (verified persistent NameID), and
`approval` (a non-sensitive review reference). Restrict access to the temporary file,
do not commit it, and delete it after use. Mapping checks the old identity and active
status, preserves the user ID and all scores, records the approval reference, clears
old admin status, and rejects identity conflicts. Admin is recalculated at next login.
Never map by email, display name, or user-supplied unverified assertions.

Before cutover, both gates are mandatory and separate: obtain Security approval
through your internal Security review process, and obtain
specific authorization to perform a real same-window Okta login. Then review
schema/identity changes, validate administrator-provided metadata and certs, assign
authorized users in the correct Okta app, configure each origin, and run the
authorized same-window login, private-gate POST, profile refresh, disabled-account,
logout, and score checks. Restart API workers after any environment or SAML
configuration change so cached Settings and trust are reloaded.
Deploy only through an explicit user action. For rollback, redeploy the previously
reviewed build/config without dropping additive tables or profile columns; the prior
authentication provider and its session policy must be reviewed before reenabling.
No Security approval has occurred, and no authorized live login has been performed.
Local or synthetic tests do not satisfy either rollout gate.
