# AGT Knowledge Base

A production-oriented knowledge base for the Alliance of Galactic Travellers community. The public React/Vite application supports server-paginated browsing, search, tags, deterministic sorting, safe Markdown rendering, article URLs, linked tables of contents, and responsive AGT styling. Authenticated authors can create and edit articles and compare the five most recent revisions; Administrators additionally control protection, restoration, and deletion.

## Architecture

```text
                    Docker Compose
Browser --HTTP(S)--> web: Nginx --+-- built React/Vite frontend
                                  |
                                  +-- /api/* --> api: Node.js API --> postgres: PostgreSQL 16
                                                                       (volume agt-postgres)
                    migrate: one-shot job that applies schema migrations before the API starts
```

The browser never connects to PostgreSQL and contains no database credential. Nginx serves the frontend and proxies `/api` to the Node.js API. Users and scrypt password hashes are stored in PostgreSQL, and the API issues and verifies signed session tokens. The API is the authorization boundary: it checks the session, role, visibility, and protection before reading or changing data. `created_at`, `created_by`, `modified_at`, `modified_by`, pinning, protection, and version fields are server-owned. PostgreSQL is reachable only through the private Compose network and an optional loopback-only port.

The project is fully self-hosted and needs no cloud account or external service.

## Roles and editing rules

| User | Visible articles | View/compare history | Create | Set visibility | Edit unprotected | Edit protected | Pin | Protect | Restore | Delete |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Public | Public (legacy or AGT level 0) | No | No | No | No | No | No | No | No | No |
| Standard | Public, Internal, Private | Yes | Yes | Public, Internal, or AGT levels 0–1 on unprotected articles | Yes | No | No | No | No | No |
| Admin | All | Yes | Yes | Any level | Yes | Yes | Yes | Yes | Yes | Yes |

AGT-standard visibility is stored as numeric levels: `0` Public (`#2aff00`), `1` Private (`#00f4ff`), `2` Restricted (`#f198e2`), `3` Top Secret (`#fd0303`), `4` SLT Restricted (`#ff9300`), and `5` SCC Restricted (`#3287f0`). Public and Standard users can read level 0, Standard users can also read level 1, and levels 2–5 are Admin-only. The legacy text values Public, Internal, and Admin remain supported with their existing access rules and colors.

Updates, restores, and deletes carry the article version. PostgreSQL applies the mutation only when that version still matches, returning HTTP `409` instead of silently overwriting a concurrent edit. Restoration creates a new latest revision rather than rewriting history.

## Prerequisites

- Node.js 22 or newer and npm
- For local data: Docker Compose or PostgreSQL 16

## Local development

1. Install dependencies and create local configuration:

   ```bash
   npm ci
   cp .env.example .env.local
   ```

2. Start PostgreSQL and apply migrations:

   ```bash
   POSTGRES_PASSWORD=postgres \
     LOCAL_AUTH_SECRET=local-development-only-secret-32-chars \
     docker compose up -d postgres
   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/agt_knowledge_base npm run db:migrate
   ```

3. Start the API and Vite in separate terminals:

   ```bash
   set -a && source .env.local && set +a && npm run api:dev
   npm run dev
   ```

Open the app and complete the first-run setup to create the initial Administrator. The API verifies signed local session tokens and does not provide an insecure authentication bypass. Public browsing works without a token.

## Docker self-hosting

The Compose stack runs the web frontend, API, schema migrations, PostgreSQL, and local authentication.

1. Install Docker Engine with the Compose plugin and clone this repository (the `main` branch).
2. Create the deployment configuration:

   ```bash
   cp docker.env.example .env
   ```

   Replace `POSTGRES_PASSWORD` and `LOCAL_AUTH_SECRET` with independent random values. For example, `openssl rand -hex 32` generates a suitable value for either setting. If the site will be reached anywhere other than `http://localhost:8080`, also set `APP_ORIGIN` to its externally visible origin. These secrets must not be committed.

3. Build and start the stack:

   ```bash
   docker compose up -d --build
   docker compose ps
   ```

   The one-shot `migrate` service waits for PostgreSQL, applies pending non-destructive migrations, and must finish successfully before the API starts.

4. Open `http://localhost:8080` (or the configured host and port). A fresh installation redirects to `/setup`, where the first visitor creates the single protected super administrator. Setup is transactionally locked and is permanently disabled as soon as any local user exists. After setup, use **Admin → Users** to create, update, deactivate, reset passwords for, or remove eligible local users.

The super administrator cannot be deleted, deactivated, or demoted. Other administrators cannot change that account's credentials or identity. The super administrator can update their own profile and password from the Users section. **Admin → Data** contains archive statistics, article inventory, and canonical/orphan tag management. **Admin → Application settings** controls branding, default article visibility, and public browsing. **Admin → Backup & restore**, shown only to the super administrator, exports and restores the whole database (see [Backups](#backups)). Personal accessibility, download, and search-view preferences remain browser-local in the Settings dialog.

The command-line user tool is retained for recovery only. For example, an upgraded installation with local users but no active Admin deliberately fails migration `009_admin`; use the recovery command below to activate or create an Admin against the pre-migration schema, then rerun `docker compose up -d --build`:

```bash
read -rsp "Recovery password: " LOCAL_USER_PASSWORD && echo
export LOCAL_USER_PASSWORD
docker compose run --rm --no-deps -e LOCAL_USER_PASSWORD api \
  node server/scripts/manage-local-user.js \
  --username recovery-admin \
  --display-name "Recovery Administrator" \
  --role Admin \
  --confirm
unset LOCAL_USER_PASSWORD
```

Do not use the CLI as the normal first-run flow. After migration `009_admin` succeeds, perform routine account management in the application.

Configuration is read from `.env`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `APP_BIND_ADDRESS` | `0.0.0.0` | Host interface exposed by the web container |
| `APP_PORT` | `8080` | Host HTTP port |
| `APP_ORIGIN` | `http://localhost:8080` | Browser origin allowed by the API |
| `POSTGRES_DB` | `agt_knowledge_base` | PostgreSQL database name |
| `POSTGRES_USER` | `postgres` | PostgreSQL user |
| `POSTGRES_PASSWORD` | none | Required PostgreSQL password |
| `POSTGRES_BIND_ADDRESS` | `127.0.0.1` | Interface for optional host database access |
| `POSTGRES_PORT` | `5432` | Host PostgreSQL port |
| `LOCAL_AUTH_SECRET` | none | Required secret used to sign local sessions; at least 32 characters |
| `LOCAL_AUTH_SESSION_HOURS` | `12` | Session lifetime, from 1 to 168 hours |

Changing `LOCAL_AUTH_SECRET` immediately invalidates every active session. Do not expose the PostgreSQL port beyond loopback.

Useful operations:

```bash
docker compose logs -f web api migrate postgres
docker compose ps
docker compose down                # stop containers without deleting data
```

The `agt-postgres` volume contains the database. Do not run `docker compose down --volumes` unless you intend to permanently delete the data.

### HTTPS

For anything other than local use, put a TLS-terminating reverse proxy in front of `APP_PORT`; passwords and session tokens must not travel over plaintext HTTP. Bind the web container to loopback so only the proxy can reach it, and set `APP_ORIGIN` to the public HTTPS origin:

```text
APP_BIND_ADDRESS=127.0.0.1
APP_PORT=8080
APP_ORIGIN=https://kb.example.org
```

With [Caddy](https://caddyserver.com/docs/), which obtains and renews certificates automatically, the whole proxy configuration is:

```text
kb.example.org {
  reverse_proxy 127.0.0.1:8080
}
```

Any other proxy (Traefik, Nginx, HAProxy) works the same way.

Behind a reverse proxy, the bundled Nginx sees every request as coming from the proxy, so the sign-in rate limit (5 attempts per minute per client address) is shared by all users. To keep it per client, configure Nginx's [real IP module](https://nginx.org/en/docs/http/ngx_http_realip_module.html) in `nginx.conf` to trust the proxy's `X-Forwarded-For` header, or rate-limit sign-in at the proxy instead.

### Backups

The super administrator can back up and restore the database from **Admin → Backup & restore**:

- **Download backup** exports every article, revision, tag, author record, local user account (including password hashes), and the application settings from one consistent snapshot as a JSON file named `agt-backup-YYYYMMDD-HHMMSS.json`.
- **Restore backup** replaces *all* current data with a backup file's contents. The restore runs in a single transaction: an invalid file, a constraint violation, or any other error leaves the current data unchanged. After a successful restore every user, including the super administrator, is signed out and signs in with the accounts and passwords stored in the backup.

A backup restores only into an installation with exactly the same applied migrations; restoring a file from a different version is rejected rather than partially applied. The file must contain exactly one active super administrator, and uploads are limited to 100 MB (`backupMaxBodyBytes` in `backend/routes.ts` and `client_max_body_size` for `/api/admin/backup` in `nginx.conf`; change both together). If a TLS reverse proxy sits in front of the stack, allow request bodies of that size there as well. Only the super administrator can use these routes; other administrators receive HTTP `403`.

Backup files contain password hashes and every restricted article. Store them as securely as the database itself, and never commit them.

For host-level backups, scheduled backups, or moving data between versions, use `pg_dump` from the running `postgres` container:

```bash
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' \
  > "agt-backup-$(date +%Y%m%d-%H%M%S).dump"
```

Keep backups off the host and test restores periodically. To restore a backup into the stack, replacing the current data:

```bash
docker compose stop web api
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner' \
  < agt-backup-YYYYMMDD-HHMMSS.dump
docker compose up -d
```

Restoring a backup from an older version is safe: on start, the `migrate` service applies any migrations the backup is missing.

### Upgrades

1. Back up the database (see above).
2. Pull the new version: `git pull`.
3. Rebuild and restart: `docker compose up -d --build`. The `migrate` service applies pending migrations before the new API starts.
4. Check `docker compose ps` and `docker compose logs migrate api`.

While the stack restarts, the previous API container keeps serving until it is replaced, and requests that depend on just-migrated tables can fail for a few seconds. To avoid that, run `docker compose stop web api` before step 3.

### Migrating from the AWS deployment

Earlier versions were deployed on AWS (Amplify Hosting, API Gateway, Lambda, RDS, and Cognito). That code is no longer part of this branch; it is preserved on the frozen `staging` branch, which an existing AWS test deployment still builds from. Do not change or delete `staging` while that deployment is in use.

A documented procedure for moving data from an AWS deployment is planned. In outline: export the RDS database with `pg_dump`, restore it into the Compose PostgreSQL, and let the `migrate` service bring the schema up to date. Then create a local account for each Cognito user, reusing their Cognito user ID (`sub`) as the account ID so existing authorship and revision history stay attached. Cognito cannot export passwords, so each migrated user needs a new password set by an Administrator.

References: [Install Docker Engine](https://docs.docker.com/engine/install/) and [install Docker Compose](https://docs.docker.com/compose/install/).

## Checks

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

GitHub Actions runs these checks and builds both Docker images for every pull request and every push to `main` (`.github/workflows/ci.yml`). See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines.

## Database migrations

Migrations are recorded in `schema_migrations` and are idempotent. `npm run db:migrate` (and the Compose `migrate` service) applies every pending non-destructive migration.

Migrations marked as requiring an explicit target are destructive contract phases and are not applied by default. Set `MIGRATION_TARGET_ID` to apply through a specific migration, for example `MIGRATION_TARGET_ID=007_canonical_tags_contract npm run db:migrate`. Do not target a contract migration until the application version that depends on it is running.

## Data and content security

- SQL values are parameterized; requested sort fields are mapped through a fixed allowlist.
- Local passwords are hashed with scrypt and random salts; local sessions use expiring HMAC signatures and login attempts are rate-limited by Nginx.
- Markdown is rendered by `react-markdown` with GFM and `rehype-sanitize`; raw HTML is not enabled.
- The API rejects raw HTML, JSX tags, and MDX `import` / `export` statements. MDXEditor is used as a Markdown authoring surface only; content is never executed as MDX.
- Article writes are validated with Zod and capped at 250,000 characters and 12 tags.
- API errors do not return database details; a rejected backup restore names only the table and constraint the file violated. API logs include a request ID for unexpected failures.
- Database backups are available only to the active super administrator, are verified against the database's applied migrations, and are restored in a single transaction that signs out every user.
- PostgreSQL timestamps are `timestamptz` values generated by the server and serialized as UTC ISO 8601.

## Repository layout

```text
src/              React UI, authentication session, safe Markdown, editors
backend/          HTTP server, route table, domain services, authorization, PostgreSQL adapter
migrations/       Reviewable SQL schema
scripts/          migration and local-user recovery
.github/          CI workflow
```
