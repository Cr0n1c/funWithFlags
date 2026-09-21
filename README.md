# Fun With Flags

Retro CRT-terminal Capture The Flag platform for Semgrep's Cyber Security Awareness Month.

* **`ui/`** – the terminal front end (TypeScript + SCSS, built with Vite, served by nginx). nginx also
  reverse-proxies `/api/*` to the middleware so the browser only ever talks to one origin.
* **`api/`** – FastAPI middleware: Okta OIDC login, session cookies, challenge catalogue, flag
  submission, leaderboard, admin API, audit log. Postgres via SQLAlchemy 2 (async) + Alembic.
* **`charts/funwithflags/`** – Helm chart deploying both containers into one namespace. A dev-only
  Postgres is available behind `devPostgres.enabled`; production points at a managed database.
* **`docker-compose.yml`** – the same two images plus Postgres for local development.

![Retro Terminal](docs/screenshot.png)

## Architecture

```
browser ──► ui (nginx :8080) ──► /api/* ──► api (uvicorn :8000) ──► Postgres
                │                                  │
                └── static Vite bundle             └── Okta (OIDC authorization code + PKCE)
```

* The API is a **confidential OIDC client**. The browser is redirected to Okta, Okta redirects back to
  `/api/auth/callback`, the API exchanges the code server-side, verifies the ID token against Okta's
  JWKS, and issues an `HttpOnly` signed session cookie. No Okta token ever reaches the browser.
* On every login the API records the player's **username** (`preferred_username`), **full name**
  (`name`) and **groups** (`groups` claim) in the `users` table. Members of `ADMIN_GROUPS` get the
  `/api/admin/*` endpoints.
* Flags are stored as `HMAC-SHA256(FLAG_HASH_SECRET, normalized_flag)`; plaintext flags are never
  persisted and submitted text is not logged.
* All configuration is environment variables (see [`.env.example`](.env.example)). The Helm chart
  maps the same names onto a ConfigMap (non-secret) and a Secret.

## Terminal commands

Console built-ins: `help`, `about`, `login`, `logout`, `status`, `challenges [slug]`,
`submit <slug> <flag>`, `leaderboard`, `clear`, `reset-shell`. Nothing needs a login except
`submit`; the Okta session exists only to attribute solves to a player.

Everything else is executed on **hpux01**, a fake HP-UX 11.11 machine that runs entirely in the
browser (see below). `ls -la`, `cd /etc`, `cat /etc/motd`, `find / -name "*.sh"`,
`grep -ri password /home`, `more /var/adm/syslog/syslog.log`, pipes, redirects and `vi` all work.

### The hpux01 sandbox (`ui/src/js/shell/`)

* Built on [`@lifo-sh/core`](https://www.npmjs.com/package/@lifo-sh/core), a Unix-like shell and
  VFS in TypeScript. It is loaded lazily as its own chunk (~280 KB gzipped) on the first shell
  command, so the banner is not delayed.
* `tree.ts` holds the seeded filesystem (about 300 files: `/etc`, `/var/adm` logs, cron, home
  directories, a floppy and two CDs). It is plain data; edit it and bump `SEED_VERSION` in
  `hpux.ts` to roll a new image out to players.
* Lifo has no permission model, so `hpux.ts` layers one on: the player is `operator` (uid 201,
  group sys), `ls -l` shows the modes and owners from the tree, read commands answer
  `Permission denied` for root-only files, and write commands refuse directories the operator
  could not write to. Files the operator may not read are seeded **empty**, so even un-wrapped
  tools and redirects cannot leak them.
* The player's own files (created with `vi`, `cp`, `mkdir`, `>` ...) persist in that browser's
  IndexedDB. `reset-shell` restores the pristine image.
* `vi` is a line editor in vi's clothing (`editor.ts`): typed lines append, `:p` prints,
  `:Nd` deletes, `:wq` saves, `:q!` abandons, `:help` lists the rest.
* Touching `/floppy`, `/cdrom`, `/SD_CDROM` or their device nodes adds a two to four second delay
  with a synthesised floppy-seek or CD spin-up sound (`drives.ts`, Web Audio API, no assets).
* Because the tree ships in the JavaScript bundle, anything in it is readable through DevTools.
  Treat hints hidden there as soft; the flags themselves are only verified by the API.

## Local development (docker compose)

```bash
cp .env.example .env            # fill in Okta values; `make secrets` prints random secrets
make up                         # builds both images, starts db + api + ui
open http://localhost:8080
make logs                       # follow logs
make down                       # stop (keeps the DB volume); `make reset` wipes it
```

Challenges are loaded from the file mounted at `/config/challenges.yaml` when the API starts
(`CHALLENGES_FILE`). By default that is [`api/challenges.example.yaml`](api/challenges.example.yaml);
set `CHALLENGES_FILE=./challenges.yaml` in `.env` to use your own (it is git-ignored because it holds
flags). Re-run `make api-seed` after editing.

Working on one side only:

```bash
make api-sync && make api-test && make api-lint     # uv, pytest, ruff, ty
make ui-install && make ui-lint && make ui-build    # npm, eslint, tsc, vite
make ui-dev                                         # Vite dev server on :5173, /api proxied to :8000
```

## Okta setup

1. Okta Admin → Applications → **Create App Integration** → OIDC, **Web Application**.
2. Grant type: Authorization Code. (PKCE is used in addition to the client secret.)
3. Sign-in redirect URI: `https://<your-host>/api/auth/callback` (local: `http://localhost:8080/api/auth/callback`).
4. Sign-out redirect URI (optional): `https://<your-host>/`, then set `OKTA_POST_LOGOUT_REDIRECT_URI`.
5. Assign the app to the groups that should be able to play.
6. **Groups claim** – so the API receives group membership:
   * Custom authorization server (`OKTA_ISSUER=https://<org>.okta.com/oauth2/default`):
     Security → API → your authorization server → Claims → **Add Claim**: name `groups`, include in
     *ID Token* (Always), value type *Groups*, filter *Matches regex* `.*` (or a tighter filter), and
     include in scope `groups` (create the scope if it does not exist) — or in *any scope*.
   * Org authorization server (`OKTA_ISSUER=https://<org>.okta.com`): on the app integration →
     Sign On → OpenID Connect ID Token → Groups claim type *Filter*, `groups` *Matches regex* `.*`.
7. Copy the client ID and secret into `OKTA_CLIENT_ID` / `OKTA_CLIENT_SECRET`.

`OKTA_SCOPES` defaults to `openid profile email groups`; drop `groups` if you only use an ID-token
claim without a groups scope. `ADMIN_GROUPS` is a comma-separated list of Okta group names.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `OKTA_ISSUER`, `OKTA_CLIENT_ID`, `OKTA_CLIENT_SECRET`, `OKTA_REDIRECT_URI` | yes | Okta app integration |
| `OKTA_SCOPES`, `OKTA_GROUPS_CLAIM`, `OKTA_USERNAME_CLAIM`, `OKTA_POST_LOGOUT_REDIRECT_URI` | no | Claim/scope tuning |
| `ADMIN_GROUPS` | no | Groups granted `/api/admin/*` |
| `SESSION_SECRET` (≥32 chars), `FLAG_HASH_SECRET` (≥32 chars) | yes | Cookie signing, flag hashing |
| `SESSION_COOKIE_SECURE`, `SESSION_MAX_AGE_SECONDS`, `SESSION_COOKIE_NAME`, `SESSION_COOKIE_SAMESITE` | no | Session cookie |
| `DATABASE_URL` **or** `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/`DB_PASSWORD` | yes | Postgres |
| `APP_BASE_URL` | yes | UI origin for post-login redirect + CORS |
| `CHALLENGES_FILE`, `SUBMIT_RATE_LIMIT_PER_MINUTE`, `LOG_LEVEL`, `LOG_JSON`, `ENVIRONMENT` | no | Misc |
| `API_UPSTREAM` (UI container only) | no | `host:port` nginx proxies `/api/` to (default `api:8000`) |

## API

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/health`, `/api/ready` | – | Liveness / readiness (DB check) |
| GET | `/api/auth/login` | – | Redirect to Okta |
| GET | `/api/auth/callback` | – | Okta redirect target |
| GET | `/api/auth/me` | session | Current user incl. groups, score |
| POST | `/api/auth/logout` | session | Clear session |
| GET | `/api/challenges`, `/api/challenges/{slug}` | – | Active challenges (`solved` only set with a session) |
| POST | `/api/challenges/{slug}/submit` | session | `{"flag": "..."}` |
| GET | `/api/leaderboard?limit=` | – | Top players |
| GET/PUT/DELETE | `/api/admin/challenges[/{slug}]` | admin | Manage challenges |
| GET | `/api/admin/users`, `/api/admin/audit`, `/api/admin/submissions` | admin | Reporting |

Interactive docs at `/api/docs` when `ENVIRONMENT != production`.

## Kubernetes (Helm)

Production-shaped install: bring your own Postgres and a Secret with
`OKTA_CLIENT_SECRET`, `SESSION_SECRET`, `FLAG_HASH_SECRET` and either `DATABASE_URL` or `DB_PASSWORD`.
Challenge definitions (they contain flags) go in a second Secret under the key `challenges.yaml`.

```bash
kubectl -n ctf create secret generic fwf --from-literal=OKTA_CLIENT_SECRET=... \
  --from-literal=SESSION_SECRET=$(openssl rand -hex 32) \
  --from-literal=FLAG_HASH_SECRET=$(openssl rand -hex 32) \
  --from-literal=DATABASE_URL=postgresql://user:pass@db.internal:5432/funwithflags
kubectl -n ctf create secret generic fwf-challenges --from-file=challenges.yaml=./challenges.yaml

helm upgrade --install fwf charts/funwithflags -n ctf \
  --set config.appBaseUrl=https://ctf.example.com \
  --set config.okta.issuer=https://acme.okta.com/oauth2/default \
  --set config.okta.clientId=0oa... \
  --set config.okta.redirectUri=https://ctf.example.com/api/auth/callback \
  --set config.adminGroups=ctf-admins \
  --set secrets.existingSecret=fwf \
  --set challenges.existingSecret=fwf-challenges \
  --set ingress.enabled=true --set ingress.hosts[0].host=ctf.example.com
```

What the chart does:

* Two Deployments (`-ui`, `-api`) + ClusterIP Services in the release namespace. The UI's nginx
  proxies `/api/` to `<release>-api:8000`, so only the UI Service needs an Ingress.
* An **init container** on each API pod runs `alembic upgrade head` (and seeds challenges when a
  challenge Secret is configured) before the pod serves. Migrations take a Postgres advisory lock,
  so several replicas starting at once serialize instead of racing. Set `migrations.enabled=false`
  if you migrate out of band.
* Non-root, read-only-rootfs containers, `automountServiceAccountToken: false`, a NetworkPolicy
  limiting API ingress to UI pods, PodDisruptionBudgets, optional HPAs.
* `devPostgres.enabled=true` adds a single-replica Postgres StatefulSet for local clusters. The chart
  refuses to render it when `config.environment=production`.

Local cluster (kind) with everything bundled:

```bash
make kind-up
OKTA_CLIENT_ID=... OKTA_CLIENT_SECRET=... make kind-deploy   # uses values-local.yaml
kubectl -n fwf port-forward svc/fwf-funwithflags-ui 8080:80
make kind-test
```

## Repository layout

```
api/            FastAPI app (app/), Alembic migrations (app/alembic/), tests/, Dockerfile
ui/             Vite project: index.html, src/js, src/sass, public/, nginx/, Dockerfile
charts/         Helm chart
docker-compose.yml, .env.example, Makefile
```

## Security notes

* Never commit `.env` or a real `challenges.yaml`; both are git-ignored.
* Rotate `SESSION_SECRET` to invalidate all sessions; rotating `FLAG_HASH_SECRET` invalidates stored
  flag hashes (re-seed afterwards).
* The UI ships a strict CSP; the only external origins are Google Fonts.
* Dependencies use a 7-day publish cooldown (`ui/.npmrc`, `[tool.uv] exclude-newer`).
