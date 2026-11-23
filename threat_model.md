# Threat Model

## Project Overview

"Fun With Flags" is a Capture-The-Flag (CTF) web application imported from an
upstream project. It presents a CRT-style browser terminal (vanilla
TypeScript + SCSS, built with Vite) backed by a Python 3.13 FastAPI service
(`artifacts/api-server/python`) using SQLAlchemy + Alembic against PostgreSQL.
Authentication is SP-initiated Okta SAML 2.0 (superseding an earlier
OIDC direction). Users solve challenges by submitting flags, earn points, and
appear on a leaderboard.

Deployed at the production origin (`APP_BASE_URL`); any access gate in front of
the origin is the hosting platform's responsibility.

## Assets

- **User identities / PII** — Okta-sourced attributes: email, first/last name,
  department, level. Usernames are pseudonymous (`saml-<hash>`); real names are
  the sensitive de-anonymizing data.
- **Sessions** — HS256 JWT session cookies (HttpOnly, Secure, SameSite=Lax),
  signed with `SESSION_SECRET`.
- **Flags** — stored only as HMAC-SHA256 hashes keyed by `FLAG_HASH_SECRET`.
- **Admin capabilities** — challenge CRUD, user/audit/submission listing.
- **Application secrets** — `SESSION_SECRET`, `FLAG_HASH_SECRET`, SAML SP
  private key / IdP cert, `DATABASE_URL`.

## Trust Boundaries

- **Browser to API** — all `/api/*` requests; the client is untrusted. Cookies
  are same-origin.
- **API to PostgreSQL** — all queries use SQLAlchemy ORM / parameterized
  statements.
- **API to Okta (SAML)** — assertions validated strictly (signatures, issuer,
  audience, InResponseTo, recipient, NameID format/qualifier, replay cache).
- **Public vs Authenticated vs Admin** — challenge listing and the leaderboard
  are public; flag submission, `/auth/me`, and `/leaderboard/me`
  require a session; `/admin/*` requires `is_admin` (an explicit allowlist of
  Okta subjects via `SAML_ADMIN_SUBJECTS`).

## Scan Anchors

- Production entry points: `artifacts/api-server/python/app/routers/`
  (`auth.py`, `challenges.py`, `leaderboard.py`, `admin.py`, `health.py`);
  app factory `app/main.py`; runtime `run_server.py`.
- Auth/session core: `app/security.py`, `app/saml.py`, `app/config.py`.
- Frontend: `artifacts/fun-with-flags/src/js/` (terminal rendering in
  `terminal/terminal.ts`, API access in `services/`).
- Dev-only / ignore unless proven reachable: `artifacts/mockup-sandbox`
  (Canvas design mockups), Express/Drizzle scaffolds (unused per PROJECT.md),
  Alembic CLI migrations (dev-only, not run at startup in production).

## Threat Categories

### Information Disclosure

The most relevant risk here. Okta profile attributes (real names, email,
department, level) are private identity data and, per project guarantees, MUST
NOT appear on shared/leaderboard surfaces. The public leaderboard endpoint must
return only pseudonymous, non-identifying fields to unauthenticated callers.
Error responses must not leak SAML toolkit diagnostics or raw assertions
(currently handled via generic `SamlError` messages). Secrets are typed as
`SecretStr` to avoid accidental logging.

### Spoofing / Improper Authentication

SAML assertions must be fully validated (signature, issuer, audience,
InResponseTo/recipient binding, NameID persistence and qualifier, single-use
replay protection). Sessions are signed JWTs with required `aud`/`exp`/`iat`.
Admin status derives solely from a subject allowlist, never from SAML
group/attribute claims.

### Elevation of Privilege

Admin routes are gated by `require_admin` (`is_admin`). Object-level access is
naturally scoped (users act only on their own solves/submissions). No IDOR
surface identified: there are no request-controlled object IDs that cross user
boundaries.

### Tampering

Flag correctness and points are computed server-side; the client only submits
flag text. Challenge mutation is admin-only with slug validation.

### Denial of Service

Per-user flag submission rate limiting is enforced in the DB. SAML response
body size is capped (256 KiB). Request bodies are otherwise bounded by schema.
