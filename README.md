# AGT Knowledge Base

A production-oriented knowledge base for the Alliance of Galactic Travellers community. The public React/Vite application supports server-paginated browsing, search, tags, deterministic sorting, safe Markdown rendering, article URLs, linked tables of contents, and responsive AGT styling. Editors create and edit articles and compare the five most recent revisions; Moderators additionally control protection, pinning, verification, restoration, deletion, and tags. A single installation Admin manages member accounts, settings, and backups from a separate panel at `/admin`.

## Architecture

```text
                    Docker Compose
Browser --HTTP(S)--> web: Nginx --> api: Node.js (Fastify) --> postgres: PostgreSQL 16
                                     serves the React/Vite UI      (volume agt-postgres)
                                     and /api/*
                    migrate: one-shot job that applies schema migrations before the API starts
```

The browser never connects to PostgreSQL and contains no database credential. The Node.js server serves the member app (`index.html`), the admin panel (`admin.html`, only at `/admin`), and the API under `/api/`; Nginx only forwards requests to it. Member accounts and their scrypt password hashes are stored in `local_users`, and the API issues and verifies signed member session tokens. The installation Admin is stored separately, in the single-row `admin` table, and signs in with a cookie session that works only for the admin API. The API is the authorization boundary: it checks the session, role, visibility, and protection before reading or changing data. `created_at`, `created_by`, `modified_at`, `modified_by`, pinning, protection, and version fields are server-owned. PostgreSQL is reachable only through the private Compose network and an optional loopback-only port.

The project is fully self-hosted and needs no cloud account or external service.

## Roles and editing rules

| User | Visible articles | View/compare history | Create | Set visibility | Edit unprotected | Edit protected | Pin, protect, verify | Restore | Delete | Manage tags |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Public | Public (legacy or AGT level 0) | No | No | No | No | No | No | No | No | No |
| Editor | Public, Internal, Private | Yes | Yes | Public, Internal, or AGT levels 0–1 on unprotected articles | Yes | No | No | No | No | No |
| Moderator | All | Yes | Yes | Any level | Yes | Yes | Yes | Yes | Yes | Yes (**Tags** page) |

Editors and Moderators are member accounts that sign in at `/login`. The **Admin** is not a member role: it is the single installation account, which signs in only at `/admin` and manages member accounts, settings, statistics, and backups. It cannot sign in to the knowledge base or write articles; use a separate member account for that. No API call or page can give a member account administrator privileges.

AGT-standard visibility is stored as numeric levels: `0` Public (`#2aff00`), `1` Private (`#00f4ff`), `2` Restricted (`#f198e2`), `3` Top Secret (`#fd0303`), `4` SLT Restricted (`#ff9300`), and `5` SCC Restricted (`#3287f0`). Public visitors and Editors can read level 0, Editors can also read level 1, and levels 2–5 are Moderator-only. The legacy text values Public, Internal, and Admin remain supported with their existing access rules and colors; legacy `Admin` articles are shown as "Admin (legacy)" and are visible to Moderators.

Updates, restores, and deletes carry the article version. PostgreSQL applies the mutation only when that version still matches, returning HTTP `409` instead of silently overwriting a concurrent edit. Restoration creates a new latest revision rather than rewriting history.

## Prerequisites

- Node.js 26 and npm 11.20 or newer within npm 11 (only to build or develop from source; the Docker images include Node.js)
- For local data: Docker Compose or PostgreSQL 16

## Local development

1. Install dependencies and create local configuration:

   ```bash
   npm ci
   cp .env.example .env.local
   cp config.example.yaml config.yaml
   ```

   Pre-restore backups go to `./data/backups` (`storage.dataDir` and `storage.backupsDir`, relative to the working directory).

2. Start PostgreSQL and apply migrations. The database container's user and password must match `database.user` in `config.yaml` (default `agt_knowledge_base`) and `AGT_KNOWLEDGE_BASE_DB_PASSWORD` in `.env.local`:

   ```bash
   POSTGRES_USER=agt_knowledge_base POSTGRES_PASSWORD=local-development-db-password \
     docker compose up -d postgres
   set -a && source .env.local && set +a && npm run db:migrate
   ```

3. Start the API and Vite in separate terminals:

   ```bash
   set -a && source .env.local && set +a && npm run dev:server
   npm run dev
   ```

`npm run dev:server` builds the API bundle (`dist-server/index.mjs`) and starts it with the variables from `.env.local`; rerun it after changing server code. The API listens on `127.0.0.1:8081` (`server.host`, `server.port`), and Vite proxies `/api` to it, so the browser sees a single origin, as it does behind Nginx. Open `http://localhost:5173/admin` and complete first-run setup with the `AGT_KNOWLEDGE_BASE_SETUP_PASSWORD` from `.env.local` to create the Admin, then create member accounts under **Users** and sign in to the knowledge base at `/login`. The API checks the member and Admin session cookies and does not provide an insecure authentication bypass. Public browsing works without signing in.

## Docker self-hosting

The Compose stack runs the web frontend, API, schema migrations, PostgreSQL, and local authentication.

1. Install Docker Engine with the Compose plugin and clone this repository (the `main` branch).
2. Create the deployment configuration:

   ```bash
   cp docker.env.example .env
   cp config.example.yaml config.yaml
   ```

   In `.env`, replace `POSTGRES_PASSWORD` and `AGT_KNOWLEDGE_BASE_SETUP_PASSWORD` with independent random values. For example, `openssl rand -hex 32` generates a suitable value for any of them. These secrets must not be committed. `config.yaml` must exist before the stack starts: Compose mounts it into the API and migration containers.

3. Build and start the stack:

   ```bash
   docker compose up -d --build
   docker compose ps
   ```

   The one-shot `migrate` service waits for PostgreSQL, applies pending non-destructive migrations, and must finish successfully before the API starts.

4. Open `http://localhost:8080/admin` (or the configured host and port) to create the Admin account. A fresh installation shows a setup screen that asks for the one-time `AGT_KNOWLEDGE_BASE_SETUP_PASSWORD` from `.env`, then the Admin username and a new password (at least 12 characters, including uppercase, lowercase, a number, and a symbol, and different from the setup password). Without `AGT_KNOWLEDGE_BASE_SETUP_PASSWORD`, setup is refused, so nobody can claim a fresh installation by reaching it first. Once setup is complete, remove `AGT_KNOWLEDGE_BASE_SETUP_PASSWORD` from `.env` and run `docker compose up -d`; until then the API logs a warning at startup and the admin panel shows a reminder.

### The admin panel

The admin panel is a separate page reachable only by visiting `/admin` directly; nothing in the knowledge base links to it, and its code is not part of the member app. It has its own sign-in and session, independent of member sign-in: signing in or out of one never affects the other.

- **Users** creates, updates, deactivates, resets passwords for, and deletes member accounts (Editor or Moderator).
- **Data** shows archive statistics and the inventory of every article at every visibility level.
- **Settings** edits the site title, subtitle and support link, default article visibility, public browsing, and backup limits. Settings defined in `config.yaml` are shown read-only, marked "Set in the configuration file" (see [Configuration](#configuration)).
- **Backup & restore** downloads and restores backups (see [Backups](#backups)).
- **Account** changes the Admin password. It requires the current password and signs out every other Admin session.
- **API** renders the API reference from the server's OpenAPI document (`/api/openapi.json`). The header shows the app version.

Members and the Admin sign in with cookie sessions: a random 32-byte token in an `HttpOnly`, `SameSite=Strict`, `Path=/` cookie (`agt_knowledge_base_member_session` for members, `agt_knowledge_base_session` for the Admin) that page scripts cannot read. Only its SHA-256 is stored (`member_sessions`, `sessions`), so signing out revokes it on the server, and sessions last `session.ttlHours`. Every state-changing request must also carry an `x-agt-request: 1` header. The cookies are marked `Secure` when a trusted proxy reports HTTPS (see [HTTPS](#https)); set `session.secureCookie` to `true` or `false` to override this. The member cookie is ignored on admin routes, and the Admin cookie on member routes. Changing a member's role, deactivating them, setting their password or deleting them ends all of their sessions.

Moderators manage canonical tags and clean up orphaned tag references on the **Tags** page of the knowledge base, linked in the header for Moderators only. Personal accessibility, download, and search-view preferences remain browser-local in the Settings dialog.

### Account recovery

**Member accounts.** The command-line tool creates or resets a member account (Editor or Moderator); it cannot create the Admin:

```bash
read -rsp "Recovery password: " AGT_KNOWLEDGE_BASE_LOCAL_USER_PASSWORD && echo
export AGT_KNOWLEDGE_BASE_LOCAL_USER_PASSWORD
docker compose run --rm --no-deps -e AGT_KNOWLEDGE_BASE_LOCAL_USER_PASSWORD api \
  node server/scripts/manage-local-user.js \
  --username recovery-moderator \
  --display-name "Recovery Moderator" \
  --role Moderator \
  --confirm
unset AGT_KNOWLEDGE_BASE_LOCAL_USER_PASSWORD
```

Use the admin panel for routine account management.

**Admin lockout.** If the Admin password is lost, delete the Admin account and its sessions, then run setup again:

```bash
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "DELETE FROM sessions; DELETE FROM admin;"'
```

Then set `AGT_KNOWLEDGE_BASE_SETUP_PASSWORD` in `.env`, run `docker compose up -d`, and complete setup at `/admin`. Member accounts and articles are not affected. Alternatively, restore a backup whose Admin password you know.

### Configuration

Configuration comes from three places (CFG-1): `config.yaml` for every setting that is not secret, `.env` for secrets, and the admin panel's **Settings** tab for the keys marked below.

Compose mounts `config.yaml` read-only at `/app/config.yaml` (the server reads `AGT_KNOWLEDGE_BASE_CONFIG_FILE`, default `./config.yaml`). [`config.example.yaml`](config.example.yaml) documents every key and its default. The file is validated when the server starts: an unknown key or an invalid value stops it with an error naming the key (for example `Invalid /app/config.yaml: server.prot: Unexpected property`), and a missing file means "all defaults" and logs a warning. The server never writes it. Changes take effect when the server restarts (`docker compose restart api`).

| Key | Default | Purpose | Also editable in the dashboard |
| --- | --- | --- | --- |
| `server.host`, `server.port` | `127.0.0.1` (`0.0.0.0` in the Docker image), `8081` | API listener | No |
| `server.trustProxy` | `false` (`config.example.yaml` sets `1`) | Proxies to trust for `X-Forwarded-For` and `X-Forwarded-Proto`: `true`, a proxy IP or CIDR (string or list), or a number of hops. Use `1` for the bundled Nginx and `2` with a TLS proxy in front of it; with `false`, every client shares Nginx's address for rate limits | No |
| `server.logLevel` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent` | No |
| `storage.dataDir`, `storage.backupsDir` | `data`, `backups` | Persistent files, relative to the working directory (`/app` in Docker); pre-restore backups go to `dataDir/backupsDir` (the `agt-backups` volume) | No |
| `database.host`, `.port`, `.name`, `.user`, `.ssl` | `localhost` (or `AGT_KNOWLEDGE_BASE_DATABASE_HOST`), `5432`, `agt_knowledge_base`, `agt_knowledge_base`, `false` | PostgreSQL connection; the password is `AGT_KNOWLEDGE_BASE_DB_PASSWORD` | No |
| `session.ttlHours` | `12` | Sign-in lifetime (1–168 hours), for the Admin and for members | No |
| `session.secureCookie` | `auto` | `Secure` attribute of the Admin cookie: `auto`, `true` or `false` | No |
| `rateLimits.login` | 10 per 15 minutes | Member sign-in, Admin sign-in and Admin password changes, each counted separately | No |
| `rateLimits.setup` | 10 per 15 minutes | First-run setup | No |
| `rateLimits.adminUploads` | 120 per 15 minutes | Backup restore uploads | No |
| `backup.preRestore.keep` | unset (keep all) | How many pre-restore backups to keep | No |
| `site.title`, `site.subtitle` | `AGT Knowledge Base`, the default subtitle | Branding | Yes |
| `site.supportUrl` | `https://www.nms-agt.com/support` | Support link (an absolute `http:` or `https:` URL) | Yes |
| `articles.defaultVisibility` | `Internal` | Default visibility of new articles | Yes |
| `access.allowPublicBrowsing` | `true` | Whether visitors who are not signed in can browse public articles | Yes |
| `backup.maxZipBytes` | `104857600` (100 MB, at most 1 GiB) | Largest backup upload | Yes |
| `backup.maxUncompressedBytes` | `268435456` (256 MB, at most 500 MB) | Largest uncompressed archive contents | Yes |
| `backup.maxEntries` | `16` | Most entries in an uploaded archive | Yes |

A dashboard-editable key resolves to the value in `config.yaml` if the file sets it, otherwise the dashboard value, otherwise the default. **The configuration file always wins**: the API rejects changes to a key the file defines with HTTP `409`, naming the key, and no settings write, migration, or backup restore can override it.

**Deprecated keys** (still accepted until 3.0.0; the server logs a warning for each one it finds): `site.applicationName` and `site.applicationSubtitle` (now `site.title` and `site.subtitle`), `backup.maxBytes` (now `backup.maxZipBytes`), `adminSession.secureCookie` (now `session.secureCookie`), `adminSession.ttlHours` (the Admin lifetime, overriding `session.ttlHours`), `rateLimits.adminLogin` and `rateLimits.adminPassword` (overriding `rateLimits.login` for those routes), and `server.frontendOrigin` (allows that browser origin and, when `https://`, makes the Admin cookie `Secure` under `auto`). A deprecated key next to its new name stops the server.

Rate limits are applied by the API, per client address, before authentication and before the request body is read; an exceeded limit returns HTTP `429` with `Retry-After`. Limits are kept in memory and reset when the API restarts.

Environment variables are only for secrets and for values the launcher sets (CFG-2). Secrets go in `.env`:

| Variable | Purpose |
| --- | --- |
| `AGT_KNOWLEDGE_BASE_SETUP_PASSWORD` | One-time password for creating the Admin at `/admin`; ignored once the Admin exists. Remove it after setup |
| `AGT_KNOWLEDGE_BASE_DB_PASSWORD` | Password of the database role. Compose sets it from `POSTGRES_PASSWORD` |
| `AGT_KNOWLEDGE_BASE_LOCAL_USER_PASSWORD` | Only for the member-recovery command (see [Account recovery](#account-recovery)) |

Set by the Dockerfile or Compose file, or for development: `AGT_KNOWLEDGE_BASE_CONFIG_FILE` (path of `config.yaml`), `AGT_KNOWLEDGE_BASE_SERVER_HOST` (listen address when `server.host` is not set; the image sets `0.0.0.0`), `AGT_KNOWLEDGE_BASE_DATABASE_HOST` (database host when `database.host` is not set; Compose sets `postgres`), `AGT_KNOWLEDGE_BASE_STATIC_DIR` (path of the built client), and `NODE_ENV`.

Compose itself also reads these variables from `.env`: `POSTGRES_PASSWORD` (required; the database container's password, passed to the API as `AGT_KNOWLEDGE_BASE_DB_PASSWORD`), `POSTGRES_DB` and `POSTGRES_USER` (defaults `agt_knowledge_base` and `postgres`, used when the database container is first created), `POSTGRES_BIND_ADDRESS` and `POSTGRES_PORT` (`127.0.0.1`, `5432`), and `APP_BIND_ADDRESS` and `APP_PORT` (`127.0.0.1`, `8080`, the web container's host address and port).

**Deprecated variables** (still read until 3.0.0, each with a startup warning): `AGT_SETUP_PASSWORD`, `CONFIG_FILE`, `DB_PASSWORD`, `DATABASE_URL`, `LOCAL_USER_PASSWORD` (use the `AGT_KNOWLEDGE_BASE_` names above), `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DATABASE_SSL` (use `database.*` in `config.yaml`), and `AUTH_MODE` (only `local` is accepted). Compose still passes `DB_USER` and `DB_NAME` from `POSTGRES_USER` and `POSTGRES_DB`; set `database.user` (and `database.name` if you changed it) in `config.yaml` to stop the warning.

`API_HOST`, `API_PORT`, `APP_ORIGIN`, `LOCAL_FRONTEND_ORIGIN`, and `LOCAL_AUTH_SESSION_HOURS` are no longer read: use `server.*` and `session.ttlHours` in `config.yaml`.

`LOCAL_AUTH_SECRET` is no longer used (members have cookie sessions); the server logs a reminder while it is still set. Do not expose the PostgreSQL port beyond loopback.

Useful operations:

```bash
docker compose logs -f web api migrate postgres
docker compose ps
docker compose down                # stop containers without deleting data
```

The `agt-postgres` volume contains the database. Do not run `docker compose down --volumes` unless you intend to permanently delete the data.

### HTTPS

The server speaks plain HTTP only (SEC-4), so a default installation is reachable only from the host it runs on: the server listens on `127.0.0.1` (`server.host`), and Compose publishes the web container on `127.0.0.1:8080` (`APP_BIND_ADDRESS`, `APP_PORT`). To serve other machines, put a TLS-terminating reverse proxy in front of it; passwords and session cookies must not travel over plaintext HTTP. The server logs one warning per process (source `security`) the first time a sign-in or setup request arrives over plain HTTP from another machine.

With [Caddy](https://caddyserver.com/docs/), which obtains and renews certificates automatically, the whole proxy configuration is [`deploy/Caddyfile.example`](deploy/Caddyfile.example):

```text
kb.example.org {
  reverse_proxy 127.0.0.1:8080
}
```

and in `config.yaml`:

```yaml
server:
  trustProxy: 2
```

Any other proxy (Traefik, Nginx, HAProxy) works the same way. `server.trustProxy: 2` trusts the TLS proxy and the bundled Nginx, so rate limits see the client address the proxy forwarded (it must set `X-Forwarded-For`, as Caddy does) and the API sees the `X-Forwarded-Proto: https` the proxy sends, which marks the session cookies `Secure` (keep `session.secureCookie: auto`). Only if the proxy runs on another machine, set `APP_BIND_ADDRESS` to an interface it can reach and restrict that port to the proxy's address with a firewall. The proxy must also accept request bodies of at least `backup.maxZipBytes` (100 MB by default) for backup uploads.

### Backups

The Admin backs up and restores the installation from **Backup & restore** in the admin panel.

**Download backup** creates `agt-kb-backup-YYYYMMDD-HHMMSS.zip` from one consistent database snapshot. It contains:

- `database.json`: every article, revision, tag, author record, member account, the Admin account, and the dashboard settings;
- `config.yaml`, if the installation has one;
- `manifest.json`: the format version, application version, applied migrations, creation time, and a SHA-256 checksum for every file.

Admin sessions and `.env` are never included. **Backups contain the Admin and member password hashes and every restricted article**: store them as securely as the database itself, and never commit them.

**Restoring is two steps: preview, then restore.** Uploading a backup first previews it and changes nothing. The preview checks the manifest checksums, that the archive contains only the expected files (no other paths, directories, symlinks, or `..`), the `backup.maxZipBytes`, `backup.maxEntries`, and `backup.maxUncompressedBytes` limits (checked while decompressing), that it contains exactly one Admin account, and that its schema version is compatible. It then loads the backup into a temporary staging schema, so constraint violations are reported before anything is replaced. The preview shows per-table counts, whether an upgrade will run, a line diff between the backup's `config.yaml` and the current one, and any settings that will be ignored.

- **Versions.** A backup restores if its applied migrations are exactly the start of this installation's. Older backups are upgraded during the restore, with this installation's remaining migrations; backups from a newer version, or with migrations this installation does not know, are refused. Backups from before this archive format (JSON files) are not supported.
- **Pre-restore backup.** Before restoring, the current data is saved as `pre-restore-backup-<timestamp>.zip` in `storage.dataDir/storage.backupsDir` (the `agt-backups` volume). If it cannot be written, nothing is restored. Pre-restore backups are kept indefinitely unless `backup.preRestore.keep` is set, in which case the oldest beyond that number are deleted after a new one is written.
- **`config.yaml` is never restored.** Download the backup's copy from the preview and apply any changes by hand. Dashboard settings in the backup for keys the current `config.yaml` defines are dropped and listed in the report.
- **One transaction.** The restore validates the archive again, then replaces every table in a single transaction: an invalid file, a constraint violation, or any other error leaves the current data unchanged. Afterwards every member and the Admin are signed out; sign in at `/admin` with the Admin account stored in the backup.

The restore creates a temporary schema, so the database user needs the `CREATE` privilege on the database (the Compose user owns the database and has it). Nginx streams backup uploads to the API without buffering them, and the API checks the Admin session before reading the body and enforces `backup.maxZipBytes` itself. If a TLS reverse proxy sits in front of the stack, allow request bodies of at least `backup.maxZipBytes` there too.

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

Restoring a `pg_dump` backup from an older version is safe: on start, the `migrate` service applies any migrations the backup is missing.

### Upgrades

1. Back up the database (see above).
2. Pull the new version: `git pull`.
3. Rebuild and restart: `docker compose up -d --build`. The `migrate` service applies pending migrations before the new API starts.
4. Check `docker compose ps` and `docker compose logs migrate api`.

While the stack restarts, the previous API container keeps serving until it is replaced, and requests that depend on just-migrated tables can fail for a few seconds. To avoid that, run `docker compose stop web api` before step 3.

#### Upgrading to the separate Admin account

This release replaces the super administrator with a separate Admin account and renames member roles. Before upgrading, create `config.yaml` (`cp config.example.yaml config.yaml`) and move any `APP_ORIGIN` or `LOCAL_AUTH_SESSION_HOURS` values into it as `server.frontendOrigin` and `session.ttlHours`. Then upgrade as above. Migration `012_admin_account`:

- moves the super administrator's username and password hash into the new `admin` table and removes that account from `local_users`; its user ID stays in `app_users`, so authorship and revision history are unchanged. Sign in at `/admin` with the same username and password;
- turns former `Admin`-role users into **Moderators** (they keep every content power and lose only the admin panel) and former `Standard` users into **Editors**;
- signs every member out.

Members who previously had the `Admin` role could see the super administrator's username in the Users list. Usernames are not secret, and the password is unchanged, but consider changing the Admin password under **Account** if that matters to you.

Once the new version is running, apply the contract migration, which drops the unused `is_super_admin` column:

```bash
docker compose run --rm -e MIGRATION_TARGET_ID=014_admin_account_contract migrate
```

### Migrating from the AWS deployment

Earlier versions were deployed on AWS (Amplify Hosting, API Gateway, Lambda, RDS, and Cognito). That code is no longer part of this branch; it is preserved on the frozen `staging` branch, which an existing AWS test deployment still builds from. Do not change or delete `staging` while that deployment is in use.

A documented procedure for moving data from an AWS deployment is planned. In outline: export the RDS database with `pg_dump`, restore it into the Compose PostgreSQL, and let the `migrate` service bring the schema up to date. Then create a member account for each Cognito user, reusing their Cognito user ID (`sub`) as the account ID so existing authorship and revision history stay attached. Cognito cannot export passwords, so each migrated user needs a new password set by the Admin.

References: [Install Docker Engine](https://docs.docker.com/engine/install/) and [install Docker Compose](https://docs.docker.com/compose/install/).

## API

The API is documented in [`docs/API.md`](docs/API.md), which covers member and Admin authentication, the CSRF header, optimistic concurrency, roles and visibility, pagination, error codes, deprecated paths, and limits, with `curl` examples. Per-route detail is in the OpenAPI 3.1 document the server generates from its route schemas, served at `GET /api/openapi.json`; the admin panel renders it in its **API** tab. `GET /api/health` answers `{ "status": "ok" }` while the API and its database are up.

## Checks

```bash
npm run check   # lint (tsc -b), all tests, and the production build
```

`npm test` runs the server and shared-library tests with Node's built-in test runner and the React component tests with Vitest. GitHub Actions runs `npm run check` and builds both Docker images for every pull request and every push to `main` (`.github/workflows/ci.yml`). See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines.

## Database migrations

Migrations are recorded in `schema_migrations` and are idempotent. `npm run db:migrate` (and the Compose `migrate` service) applies every pending non-destructive migration.

Migrations marked as requiring an explicit target are destructive contract phases and are not applied by default. Set `MIGRATION_TARGET_ID` to apply through a specific migration, for example `MIGRATION_TARGET_ID=014_admin_account_contract npm run db:migrate` or, once 2.0.0 runs, `MIGRATION_TARGET_ID=016_drop_application_settings npm run db:migrate`. Do not target a contract migration until the application version that depends on it is running.

## Data and content security

- SQL values are parameterized; requested sort fields are mapped through a fixed allowlist.
- Passwords are hashed with scrypt (`N = 2^15, r = 8, p = 1`, stored as `scrypt$N$r$p$salt$hash`); a stored hash in any other format can never verify. Member and Admin sessions use random tokens stored only as SHA-256 hashes, in `HttpOnly`, `SameSite=Strict` cookies, with a CSRF header required on every write. Sign-in, setup, Admin password changes and backup uploads are rate-limited by the API.
- Every response carries a strict Content-Security-Policy (no inline scripts or styles, no external hosts except images in Markdown), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy` and `Cross-Origin-Opener-Policy`, and API and HTML responses are never cached. The API sends no CORS headers.
- Markdown is rendered by one component, `src/components/Markdown.tsx` (`react-markdown` with GFM): raw HTML is shown as text, only `http:`/`https:` and same-site links and images are kept, external links open in a new tab with `rel="noopener noreferrer"`, and external images load lazily without a referrer. Images that authors link in Markdown are loaded by visitors' browsers directly from their hosts; the server itself never makes outbound requests.
- The API rejects raw HTML, JSX tags, and MDX `import` / `export` statements. MDXEditor is used as a Markdown authoring surface only; content is never executed as MDX.
- Article writes are validated with Zod and capped at 250,000 characters and 12 tags.
- API errors do not return database details; a rejected backup restore names only the table and constraint the file violated. The API logs unexpected failures, with their request ID, as JSON to standard output.
- Backups are available only to the Admin. Archives are checksummed, size- and path-checked, previewed before restoring, upgraded in an isolated staging schema, and restored in a single transaction after a pre-restore backup, signing everyone out.
- PostgreSQL timestamps are `timestamptz` values generated by the server and serialized as UTC ISO 8601.

## Repository layout

```text
src/              React member UI, authentication session, safe Markdown, editors
src/admin/        Admin panel (separate entry: admin.html)
server/           Fastify API: entry point, app, route table, domain services, authorization, PostgreSQL adapter
server/test/      Server tests (node:test)
src/lib/          Validation and API types shared by the server and the browser
migrations/       Reviewable SQL schema
docs/             API guide (API.md) and the pinned AGT web app spec
scripts/          migration and local-user recovery
.github/          CI workflow
```
