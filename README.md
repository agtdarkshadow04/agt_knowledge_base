# AGT Knowledge Base

A production-oriented knowledge base for the Alliance of Galactic Travellers community. The public React/Vite application supports server-paginated browsing, search, tags, deterministic sorting, safe Markdown rendering, article URLs, linked tables of contents, and responsive AGT styling. Editors create and edit articles and compare the five most recent revisions; Moderators additionally control protection, pinning, verification, restoration, deletion, and tags. A single installation Admin manages member accounts, settings, and backups from a separate panel at `/admin`.

## Architecture

```text
                    Docker Compose
Browser --HTTP(S)--> web: Nginx --> api: Node.js (Fastify) --> postgres: PostgreSQL 16
                                     serves the React/Vite UI      (volume agt-postgres)
                                     and /api/*, and applies
                                     schema migrations at startup
```

The browser never connects to PostgreSQL and contains no database credential. The Node.js server serves the member app (`index.html`), the admin panel (`admin.html`, only at `/admin`), and the API under `/api/`; Nginx only forwards requests to it. Member accounts and their scrypt password hashes are stored in `local_users`, and members sign in with cookie sessions. The installation Admin is stored separately, in the single-row `admin` table, and signs in with a cookie session that works only for the admin API. The API is the authorization boundary: it checks the session, role, visibility, and protection before reading or changing data. `created_at`, `created_by`, `updated_at`, `modified_by`, pinning, protection, and version fields are server-owned. The server connects to PostgreSQL as the non-superuser role `agt_knowledge_base`, which owns only the app's database and its restore preview database, and refuses to start as a superuser. PostgreSQL is reachable only through the private Compose network and an optional loopback-only port.

The project is fully self-hosted and needs no cloud account or external service.

## Roles and editing rules

| User | Visible articles | View/compare history | Create | Set visibility | Edit unprotected | Edit protected | Pin, protect, verify | Restore | Delete | Manage tags |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Public | Public (legacy or AGT level 0) | No | No | No | No | No | No | No | No | No |
| Editor | Public, Internal, Private | Yes | Yes | Public, Internal, or AGT levels 0–1 on unprotected articles | Yes | No | No | No | No | No |
| Moderator | All | Yes | Yes | Any level | Yes | Yes | Yes | Yes | Yes | Yes (**Tags** page) |

Editors and Moderators are member accounts that sign in from the sign-in button in the header (`/?view=login`). The **Admin** is not a member role: it is the single installation account, which signs in only at `/admin` and manages member accounts, settings, statistics, and backups. It cannot sign in to the knowledge base or write articles; use a separate member account for that. No API call or page can give a member account administrator privileges.

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

   Pre-restore backups go to `./data/backups` (`storage.dataDir` and `storage.backupsDir`, relative to the working directory). Backups need the PostgreSQL 16 client tools (`pg_dump`, `pg_restore`) on the `PATH`.

2. Start PostgreSQL. On first start, `deploy/postgres-init/10-app-role.sh` creates the `agt_knowledge_base` role (with `AGT_KNOWLEDGE_BASE_DB_PASSWORD` from `.env.local`) and its databases:

   ```bash
   set -a && source .env.local && set +a
   POSTGRES_PASSWORD=local-development-superuser-password docker compose up -d postgres
   ```

3. Start the API and Vite in separate terminals:

   ```bash
   set -a && source .env.local && set +a && npm run dev:server
   npm run dev
   ```

`npm run dev:server` builds the API bundle (`dist-server/index.mjs`) and starts it with the variables from `.env.local`; it applies any pending migrations before it listens. Rerun it after changing server code. The API listens on `127.0.0.1:8081` (`server.host`, `server.port`), and Vite proxies `/api` to it, so the browser sees a single origin, as it does behind Nginx. Open `http://localhost:5173/admin` and complete first-run setup with the `AGT_KNOWLEDGE_BASE_SETUP_PASSWORD` from `.env.local` to create the Admin, then create member accounts under **Users** and sign in to the knowledge base with the header's sign-in button (`/?view=login`). The API checks the member and Admin session cookies and does not provide an insecure authentication bypass. Public browsing works without signing in.

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

   On its first start the `postgres` service creates the `agt_knowledge_base` role and databases (`deploy/postgres-init/10-app-role.sh`). The API waits for PostgreSQL, applies pending migrations at startup and then listens.

4. Open `http://localhost:8080/admin` (or the configured host and port) to create the Admin account. A fresh installation shows a setup screen that asks for the one-time `AGT_KNOWLEDGE_BASE_SETUP_PASSWORD` from `.env`, then the Admin username and a new password (at least 12 characters, including uppercase, lowercase, a number, and a symbol, and different from the setup password). Without `AGT_KNOWLEDGE_BASE_SETUP_PASSWORD`, setup is refused, so nobody can claim a fresh installation by reaching it first. Once setup is complete, remove `AGT_KNOWLEDGE_BASE_SETUP_PASSWORD` from `.env` and run `docker compose up -d`; until then the API logs a warning at startup and the admin panel shows a reminder.

### The admin panel

The admin panel is a separate page reachable only by visiting `/admin` directly; nothing in the knowledge base links to it, and its code is not part of the member app. It has its own sign-in and session, independent of member sign-in: signing in or out of one never affects the other.

- **Users** creates, updates, deactivates, resets passwords for, and deletes member accounts (Editor or Moderator).
- **Data** shows archive statistics and the inventory of every article at every visibility level.
- **Settings** edits the site title, subtitle and support link, default article visibility, public browsing, backup limits and log retention. Settings defined in `config.yaml` are shown read-only, marked "Set in the configuration file" (see [Configuration](#configuration)).
- **Backup & restore** downloads and restores backups (see [Backups](#backups)).
- **Server log** and **Audit log** show, filter, search and export the two logs (see [Logs](#logs)). The Server log tab shows a badge while there are unseen warnings or errors.
- **Account** changes the Admin password. It requires the current password and signs out every other Admin session.
- **API** renders the API reference from the server's OpenAPI document (`/api/openapi.json`). The header shows the app version.

Members and the Admin sign in with cookie sessions: a random 32-byte token in an `HttpOnly`, `SameSite=Strict`, `Path=/` cookie (`agt_knowledge_base_member_session` for members, `agt_knowledge_base_session` for the Admin) that page scripts cannot read. Only its SHA-256 is stored (`member_sessions`, `sessions`), so signing out revokes it on the server, and sessions last `session.ttlHours`. Every state-changing request must also carry an `x-agt-request: 1` header. The cookies are marked `Secure` when a trusted proxy reports HTTPS (see [HTTPS](#https)); set `session.secureCookie` to `true` or `false` to override this. The member cookie is ignored on admin routes, and the Admin cookie on member routes. Changing a member's role, deactivating them, setting their password or deleting them ends all of their sessions.

Moderators manage canonical tags and clean up orphaned tag references on the **Tags** page of the knowledge base (`/?view=tags`), linked in the header for Moderators only. The **Settings** dialog (the gear button in the header) keeps a few preferences in this browser only: the search-results view, whether the article page offers PDF and Markdown downloads, and the **text size** (1× to 2×). They are stored under `agt_knowledge_base_*` keys in `localStorage`; preferences saved by 1.x under `agt-*` keys are moved there once.

Pages are addressed with query parameters on `/`: `/?article=<id>` opens an article, `&view=history` and `&view=edit` its history and editor, and `/?view=new`, `/?view=tags` and `/?view=login` the other pages. The article list keeps its search and filters in the address too. Links in the 1.x form (`/articles/<id>`, `/articles/<id>/history`, `/articles/<id>/edit`, `/articles/new`, `/tags`, `/login`) still work: the server redirects them to the new address. These redirects are removed in 3.0.0.

While a restore runs, or a change waits too long for a backup, the server answers `503 maintenance`. The member UI and the admin panel then show a notice and retry the request once a few seconds later.

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
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d agt_knowledge_base -c "DELETE FROM sessions; DELETE FROM admin;"'
```

Then set `AGT_KNOWLEDGE_BASE_SETUP_PASSWORD` in `.env`, run `docker compose up -d`, and complete setup at `/admin`. Member accounts and articles are not affected. Alternatively, restore a backup whose Admin password you know.

### Configuration

Configuration comes from three places (CFG-1): `config.yaml` for every setting that is not secret, `.env` for secrets, and the admin panel's **Settings** tab for the keys marked below.

Compose mounts `config.yaml` read-only at `/app/config.yaml` (the server reads `AGT_KNOWLEDGE_BASE_CONFIG_FILE`, default `./config.yaml`). [`config.example.yaml`](config.example.yaml) documents every key and its default. The file is validated when the server starts: an unknown key or an invalid value stops it with an error naming the key (for example `Invalid /app/config.yaml: server.prot: Unexpected property`), and a missing file means "all defaults" and logs a warning. The server never writes it. Changes take effect when the server restarts (`docker compose restart api`).

| Key | Default | Purpose | Also editable in the dashboard |
| --- | --- | --- | --- |
| `server.host`, `server.port` | `127.0.0.1` (`0.0.0.0` in the Docker image), `8081` | API listener | No |
| `server.trustProxy` | `false` (`config.example.yaml` sets `1`) | Proxies to trust for `X-Forwarded-For` and `X-Forwarded-Proto`: `true`, a proxy IP or CIDR (string or list), or a number of hops. Use `1` for the bundled Nginx and `2` with a TLS proxy in front of it; with `false`, every client shares Nginx's address for rate limits | No |
| `server.logLevel` | `info` | What the server writes to standard output: `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`. The server log always receives `info` and above | No |
| `storage.dataDir`, `storage.backupsDir` | `data`, `backups` | Persistent files, relative to the working directory (`/app` in Docker); pre-restore backups and upload scratch files go to `dataDir/backupsDir` (the `agt-backups` volume), the failed-restore marker to `dataDir` | No |
| `database.host`, `.port`, `.name`, `.user`, `.ssl` | `localhost` (or `AGT_KNOWLEDGE_BASE_DATABASE_HOST`), `5432`, `agt_knowledge_base`, `agt_knowledge_base`, `false` | PostgreSQL connection; the password is `AGT_KNOWLEDGE_BASE_DB_PASSWORD` | No |
| `database.previewName` | `agt_knowledge_base_preview` | The restore preview database, owned by the app role; every preview empties it | No |
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
| `backup.maxZipBytes` | `209715200` (200 MiB; 1024 to 2 GiB) | Largest backup upload | Yes |
| `backup.maxUncompressedBytes` | `1073741824` (1 GiB; 1024 to 8 GiB) | Largest uncompressed archive contents | Yes |
| `backup.maxEntries` | `10000` (1 to 100000) | Most entries in an uploaded archive | Yes |
| `logs.serverRetentionDays`, `logs.serverMaxEntries` | `30`, `100000` | How long and how many server log entries are kept (1–3650 days, 1000–10000000 entries) | Yes |
| `logs.auditRetentionDays`, `logs.auditMaxEntries` | `365`, `1000000` | How long and how many audit log entries are kept (30–3650 days, 10000–10000000 entries) | Yes |

A dashboard-editable key resolves to the value in `config.yaml` if the file sets it, otherwise the dashboard value, otherwise the default. **The configuration file always wins**: the API rejects changes to a key the file defines with HTTP `409`, naming the key, and no settings write, migration, or backup restore can override it.

**Deprecated keys** (still accepted until 3.0.0; the server logs a warning for each one it finds): `site.applicationName` and `site.applicationSubtitle` (now `site.title` and `site.subtitle`), `backup.maxBytes` (now `backup.maxZipBytes`), `adminSession.secureCookie` (now `session.secureCookie`), `adminSession.ttlHours` (the Admin lifetime, overriding `session.ttlHours`), `rateLimits.adminLogin` and `rateLimits.adminPassword` (overriding `rateLimits.login` for those routes), and `server.frontendOrigin` (allows that browser origin and, when `https://`, makes the Admin cookie `Secure` under `auto`). A deprecated key next to its new name stops the server.

Rate limits are applied by the API, per client address, before authentication and before the request body is read; an exceeded limit returns HTTP `429` with `Retry-After`. Limits are kept in memory and reset when the API restarts.

Environment variables are only for secrets and for values the launcher sets (CFG-2). Secrets go in `.env`:

| Variable | Purpose |
| --- | --- |
| `AGT_KNOWLEDGE_BASE_SETUP_PASSWORD` | One-time password for creating the Admin at `/admin`; ignored once the Admin exists. Remove it after setup |
| `AGT_KNOWLEDGE_BASE_DB_PASSWORD` | Password of the `agt_knowledge_base` database role (never a superuser) |
| `AGT_KNOWLEDGE_BASE_LOCAL_USER_PASSWORD` | Only for the member-recovery command (see [Account recovery](#account-recovery)) |

Set by the Dockerfile or Compose file, or for development: `AGT_KNOWLEDGE_BASE_CONFIG_FILE` (path of `config.yaml`), `AGT_KNOWLEDGE_BASE_SERVER_HOST` (listen address when `server.host` is not set; the image sets `0.0.0.0`), `AGT_KNOWLEDGE_BASE_DATABASE_HOST` (database host when `database.host` is not set; Compose sets `postgres`), `AGT_KNOWLEDGE_BASE_STATIC_DIR` (path of the built client), and `NODE_ENV`.

Compose itself also reads these variables from `.env`: `POSTGRES_PASSWORD` (required; the bootstrap superuser's password, which only the database container receives) and `POSTGRES_USER` (default `postgres`), `POSTGRES_BIND_ADDRESS` and `POSTGRES_PORT` (`127.0.0.1`, `5432`), and `APP_BIND_ADDRESS` and `APP_PORT` (`127.0.0.1`, `8080`, the web container's host address and port).

**Deprecated variables** (still read until 3.0.0, each with a startup warning): `AGT_SETUP_PASSWORD`, `CONFIG_FILE`, `DB_PASSWORD`, `DATABASE_URL`, `LOCAL_USER_PASSWORD` (use the `AGT_KNOWLEDGE_BASE_` names above), `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DATABASE_SSL` (use `database.*` in `config.yaml`), and `AUTH_MODE` (only `local` is accepted). `MIGRATION_TARGET_ID` is no longer used.

`API_HOST`, `API_PORT`, `APP_ORIGIN`, `LOCAL_FRONTEND_ORIGIN`, and `LOCAL_AUTH_SESSION_HOURS` are no longer read: use `server.*` and `session.ttlHours` in `config.yaml`.

`LOCAL_AUTH_SECRET` is no longer used (members have cookie sessions); the server logs a reminder while it is still set. Do not expose the PostgreSQL port beyond loopback.

Useful operations:

```bash
docker compose logs -f web api postgres
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

**Download backup** creates `agt-knowledge-base-backup-<timestamp>.zip` (for example `agt-knowledge-base-backup-2026-11-10T06-30-59-123Z.zip`). It contains:

- `database.dump`: a `pg_dump` custom-format dump of the app's `public` schema (every article, revision, tag, author record, member account, the Admin account and the dashboard settings), without any session rows;
- `config.yaml`, if the installation has one, byte for byte;
- `manifest.json`: the format (`agt-knowledge-base-backup`, format version 1), the application version, the database schema version, the creation time, and each file's size and SHA-256 checksum.

Sessions, `.env` and the `control` schema (the shared backup and restore state) are never included. While the dump is taken, reads continue and writes wait (for at most 30 seconds, then they answer `503`), so the dump is one consistent snapshot. **Backups contain the Admin and member password hashes and every restricted article**: store them as securely as the database itself, and never commit them. **Restore only backups made by an AGT Knowledge Base installation you trust**: a restore runs the SQL in the dump, within the limits below.

**Restoring is two steps: preview, then restore.** Uploading a backup first previews it and changes nothing:

- The archive may contain only `manifest.json`, `database.dump` and `config.yaml` (no other paths, directories, symlinks or `..`), within the `backup.maxZipBytes`, `backup.maxEntries` and `backup.maxUncompressedBytes` limits (checked while decompressing), and every checksum must match the manifest.
- The dump's table of contents is checked against an allowlist: only the app's tables, their data, sequences, defaults, constraints and indexes in the `public` schema. A function, trigger, view, extension, permission change or any other schema rejects the archive.
- The dump is then restored into the separate preview database (`database.previewName`, default `agt_knowledge_base_preview`), which is emptied before and after. That checks that it restores, its schema version, that every table exists and that the Admin's password hash could sign in.
- The preview shows per-table counts, whether the restore upgrades an older schema, warnings, a line diff between the backup's `config.yaml` and the current one, and the settings that will be ignored.

- **Versions.** Backups from an older version are migrated after the restore; backups from a newer version (a newer format or schema) are refused. **Backups made by 1.x** (a `database.json` file) are refused: restore them with 1.x, then upgrade to 2.0.
- **Maintenance.** The restore checks the upload again, then puts every API process in maintenance: requests in progress finish (for at most 30 seconds, or the restore is abandoned with `409`), and every other API request answers `503` until it ends. `GET /api/health` answers `{"status":"maintenance"}` meanwhile, so Docker does not restart the container.
- **Pre-restore backup.** The current data is then saved as `pre-restore-backup-<timestamp>.zip` (with its restore list, `pre-restore-backup-<timestamp>.list`) in `storage.dataDir/storage.backupsDir` (the `agt-backups` volume). If it cannot be written, nothing is restored. Pre-restore backups are kept unless `backup.preRestore.keep` is set; then the oldest beyond that number are deleted, each with its `.list`, after a new one is written.
- **Rollback.** The database is replaced with `pg_restore` in a single transaction, migrated and checked. If any of that fails, the pre-restore backup is restored, and the restore answers "The restore failed and was rolled back. Nothing was changed."
- **`config.yaml` is never restored.** Download the backup's copy from the preview and apply any changes by hand. Dashboard settings in the backup for keys the current `config.yaml` defines are dropped and listed in the report.
- Afterwards every member and the Admin are signed out; sign in at `/admin` with the Admin account stored in the backup.

The server runs `pg_dump` and `pg_restore` itself, as the `agt_knowledge_base` role, with the password only in the child's environment. They must be at least the PostgreSQL server's major version; the API image ships the PostgreSQL 16 client tools for the Compose stack's `postgres:16`. Outside Docker, install the client tools of your server's version (`postgresql-client-16` on Debian and Ubuntu). The role must own the preview database: new installations and `deploy/upgrade-database-role.sql` create it, and the server refuses to start if `database.previewName` names the app's own database.

Nginx streams backup uploads to the API without buffering them, and the API checks the Admin session before reading the body and enforces `backup.maxZipBytes` itself. If a TLS reverse proxy sits in front of the stack, allow request bodies of at least `backup.maxZipBytes` there too, and timeouts of several minutes for `/api/admin/restore`.

For host-level or scheduled backups, use `pg_dump` from the running `postgres` container:

```bash
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d agt_knowledge_base --format=custom --schema=public' \
  > "agt-knowledge-base-$(date +%Y%m%d-%H%M%S).dump"
```

Keep backups off the host and test restores periodically. To restore such a dump into the stack, replacing the current data:

```bash
docker compose stop web api
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d agt_knowledge_base --clean --if-exists --no-owner --role=agt_knowledge_base' \
  < agt-knowledge-base-YYYYMMDD-HHMMSS.dump
docker compose up -d
```

Restoring a `pg_dump` backup from an older version is safe: on start, the server applies any migrations the backup is missing.

#### Recovering from a failed restore

If a restore fails and its rollback fails too (for example because the database became unreachable), or the process running a restore dies, the data may be half restored. The app then stays in maintenance in every process: every API request answers `503`, and the server writes `storage.dataDir/restore-failed.json` naming the pre-restore backup and records `restore_failed` in the `control.operation` row. It refuses to start while either is present.

Until the session expires, the Admin who started the restore can still sign in to the admin panel with that session and run another restore from **Backup & restore** (for example of the pre-restore backup). If it succeeds, the app returns to normal by itself. Otherwise, restore the pre-restore backup by hand:

1. Stop the API: `docker compose stop web api`.
2. Copy the pre-restore backup and its `.list` file out of the `agt-backups` volume, unzip the backup, and restore its dump with the list, as the app role:

   ```bash
   unzip pre-restore-backup-<timestamp>.zip database.dump
   pg_restore -h <host> -U agt_knowledge_base -d agt_knowledge_base --clean --if-exists --single-transaction \
     --no-owner --no-privileges --exit-on-error --use-list=pre-restore-backup-<timestamp>.list database.dump
   ```

3. Clear the failed state: delete `restore-failed.json` from the data directory, and run as the app role:

   ```sql
   UPDATE control.operation SET state = 'idle', pre_restore_backup = NULL, admin_session_hash = NULL,
     admin_username = NULL, admin_session_expires_at = NULL WHERE id = 1 AND state = 'restore_failed';
   ```

4. Start the stack: `docker compose up -d`.

The app never clears the failed state by itself because a file is missing: if only one of the two is present (for example after the container was recreated), the start-up error names the missing one; check the data before clearing both.

### Logs

The server keeps two logs in the `logs` schema of its database, shown in the admin panel. **Neither log is part of a backup, and a restore never changes them**, so the audit log keeps its record of a restore and of everything before it.

- **Server log:** what the server did by itself: startup (version, schema versions, address, configuration file), configuration warnings such as the setup-password reminder, every migration, backups and restores, each retention run that deleted entries, and every unexpected error with its message and stack (source `http`, with the request ID). The Admin can filter, search, export and clear it. Everything at `info` and above also goes to standard output (`docker compose logs api`), and `server.logLevel` controls only that output.
- **Audit log:** what users did: every request that changes something (articles, tags, member accounts, settings with their old and new values, backups and restores, sign-ins, sign-outs, setup and password changes, whether they succeeded or not), backup downloads and log exports, every denied request to the admin API, and every rate-limited request. Each entry records the time, whether the actor was the Admin, a member or anonymous, the Admin's or member's username, the action (the API operation), the route, the affected article, tag or member, the outcome and status code, the request ID, and a short summary of the change. Article bodies, passwords and other submitted values are never recorded, and a failed request records only which fields were invalid. Identical failures from the same address within a minute are counted in one entry. The Admin can filter, search and export it, but no one can edit or clear it through the app.

**Privacy.** The audit log never stores IP addresses. It stores a pseudonymous hash of the client address: the first 16 hex characters of an HMAC-SHA256 with a random key kept in the log store (for IPv6, of the /64 prefix). The hash can tell that two requests came from the same network address without revealing the address. Together with Admin and member usernames, it is kept for `logs.auditRetentionDays` (365 days by default, at least 30). Server log entries are kept for `logs.serverRetentionDays` (30 days). A retention job deletes older entries at startup and every hour, and then the oldest entries beyond `logs.serverMaxEntries` and `logs.auditMaxEntries` (in the audit log, denied, rate-limited and failed requests go before successes).

Exports are JSON Lines or CSV files named `agt-knowledge-base-<server|audit>-log-<timestamp>.<ext>`. CSV cells that a spreadsheet would treat as a formula start with a `'`.

### Upgrades

1. Back up the database (see above).
2. Pull the new version: `git pull`.
3. Rebuild and restart: `docker compose up -d --build --remove-orphans`. The new API applies pending migrations before it listens; several processes starting together take turns under a database lock.
4. Check `docker compose ps` and `docker compose logs api`.

A database whose schema is newer than the version you start stops the server with a clear message (for example after rolling back without restoring a backup): install the newer version again, or restore a backup made by the older one.

#### Upgrading to 2.0

2.0 connects to PostgreSQL as its own non-superuser role, `agt_knowledge_base`, instead of the bootstrap superuser, and refuses to start as a superuser (DATA-11). An existing 1.x database needs the role once:

1. Download a backup from the admin panel (**Backup & restore**) and stop the stack: `docker compose stop`. 2.0 cannot restore 1.x backups (they need 1.x), so also take a `pg_dump` of the database (see [Backups](#backups)).
2. Check out 2.0 and add a new random `AGT_KNOWLEDGE_BASE_DB_PASSWORD` to `.env` (see `docker.env.example`). If your `config.yaml` sets `database.user` or `database.name` to the old superuser or a non-default database, remove `database.user` and keep `database.name` only if your database is not called `agt_knowledge_base`.
3. Create the role and hand it the database, as the superuser:

   ```bash
   set -a && . ./.env && set +a
   docker compose up -d postgres
   docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" \
     -d "${POSTGRES_DB:-agt_knowledge_base}" -v app_password="$AGT_KNOWLEDGE_BASE_DB_PASSWORD" \
     < deploy/upgrade-database-role.sql
   ```

   It creates the role, transfers the database and every table to it, removes the unused `pgcrypto` extension, and creates the restore preview database. It is safe to run again.
4. `docker compose up -d --build --remove-orphans` (this also removes the old `migrate` container). The server applies the remaining migrations, including the 1.x contract migrations that used to need `MIGRATION_TARGET_ID`.

#### Upgrading to the separate Admin account

This release replaces the super administrator with a separate Admin account and renames member roles. Before upgrading, create `config.yaml` (`cp config.example.yaml config.yaml`) and move any `APP_ORIGIN` or `LOCAL_AUTH_SESSION_HOURS` values into it as `server.frontendOrigin` and `session.ttlHours`. Then upgrade as above. Migration `012_admin_account`:

- moves the super administrator's username and password hash into the new `admin` table and removes that account from `local_users`; its user ID stays in `app_users`, so authorship and revision history are unchanged. Sign in at `/admin` with the same username and password;
- turns former `Admin`-role users into **Moderators** (they keep every content power and lose only the admin panel) and former `Standard` users into **Editors**;
- signs every member out.

Members who previously had the `Admin` role could see the super administrator's username in the Users list. Usernames are not secret, and the password is unchanged, but consider changing the Admin password under **Account** if that matters to you.

The contract migration that drops the unused `is_super_admin` column runs automatically from 2.0 on.

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

Schema changes are numbered SQL files, `server/migrations/NNNN_<name>.sql`, listed in `MIGRATIONS` in `server/db.ts` (DATA-3). The server applies every pending one at startup, each in its own transaction, under the PostgreSQL advisory lock `hashtext('agt_knowledge_base_migrations')`, and records it in `schema_migrations (version, name, applied_at)` (DATA-4, DATA-11). It refuses to start when the database has a migration it does not know (a newer schema) or when it is connected as a superuser. `MIGRATION_TARGET_ID` and `npm run db:migrate` no longer exist.

## Data and content security

- SQL values are parameterized; requested sort fields are mapped through a fixed allowlist.
- Passwords are hashed with scrypt (`N = 2^15, r = 8, p = 1`, stored as `scrypt$N$r$p$salt$hash`); a stored hash in any other format can never verify. Member and Admin sessions use random tokens stored only as SHA-256 hashes, in `HttpOnly`, `SameSite=Strict` cookies, with a CSRF header required on every write. Sign-in, setup, Admin password changes and backup uploads are rate-limited by the API.
- Every response carries a strict Content-Security-Policy (no inline scripts or styles, no external hosts except images in Markdown), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy` and `Cross-Origin-Opener-Policy`, and API and HTML responses are never cached. The API sends no CORS headers.
- Markdown is rendered by one component, `src/components/Markdown.tsx` (`react-markdown` with GFM): raw HTML is shown as text, only `http:`/`https:` and same-site links and images are kept, external links open in a new tab with `rel="noopener noreferrer"`, and external images load lazily without a referrer. Images that authors link in Markdown are loaded by visitors' browsers directly from their hosts; the server itself never makes outbound requests.
- The API rejects raw HTML, JSX tags, and MDX `import` / `export` statements. MDXEditor is used as a Markdown authoring surface only; content is never executed as MDX.
- Article writes are validated with Zod and capped at 250,000 characters and 12 tags.
- API errors do not return database details; a rejected backup says which check failed, never the `pg_restore` output, which the server logs instead. The API logs unexpected failures, with their request ID, to the server log and to standard output, and never logs passwords, tokens, cookies, request bodies or raw IP addresses (see [Logs](#logs)).
- Backups are available only to the Admin. Archives are checksummed and size- and path-checked, their dump's table of contents is allowlisted, and they are previewed in a separate database before restoring. A restore runs in maintenance, in a single transaction after a pre-restore backup, rolls back if anything fails, and signs everyone out. The app role is not a superuser, so even an allowed dump can only create and fill tables in the two databases it owns.
- PostgreSQL timestamps are `timestamptz` values generated by the server and serialized as UTC ISO 8601.

## Repository layout

```text
src/              Member UI: src/components/ (pages, dialogs, icons), src/agt-base.css (AGT base stylesheet), src/styles.css
src/admin/        Admin panel (separate entry: admin.html) and admin.css
public/           AGT logo, fonts and font licences, copied unmodified from the spec (UI-15)
server/           Fastify API: entry point, app, route table, domain services, authorization, PostgreSQL adapter
server/test/      Server tests (node:test)
src/lib/          Framework-free code: validation and API types shared with the server, the API client, deep links, preferences
tests/e2e/        Browser tests (Playwright): npm run test:e2e
server/migrations/ SQL migrations (app, control and logs schemas)
docs/             API guide (API.md) and the pinned AGT web app spec
scripts/          Member-account recovery CLI
.github/          CI workflow
```

## Credits

The AGT logo and the fonts come unmodified from the [AGT Web Application Specification](https://github.com/agtdarkshadow04/agt_webapp_specification/blob/v6.0.0/assets/README.md) (v6.0.0). The logo is © Alliance of Galactic Travellers, all rights reserved, and is used only in AGT apps.

- **NMS Futura** (`public/NMSFuturaProBook_Kerned.ttf`), the interface font: by No Man's Sky Community Developers & Designers (NMSCD), designer Blend3rman (licence notice © 2020 Hector Javier Gonzalez Rivera), based on the typeface of Hello Games' No Man's Sky. Licensed under the [SIL Open Font License 1.1](public/fonts/NMSFuturaProBook-OFL.txt). Source: [NMSCD/No-Mans-Sky-Universal-Font](https://github.com/NMSCD/No-Mans-Sky-Universal-Font/blob/master/assets/font/NMSFuturaProBook_Kerned/Web-TT/NMSFuturaProBook_Kerned.ttf).
- **Twemoji Country Flags** (`public/fonts/TwemojiCountryFlags.woff2`), which shows flag emoji in articles: flag artwork by Twitter, Inc. and other contributors (Twemoji), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); font packaging © 2022 TalkJS, MIT ([licence file](public/fonts/TwemojiCountryFlags-LICENSE.md)). Source: [talkjs/country-flag-emoji-polyfill](https://github.com/talkjs/country-flag-emoji-polyfill) 0.1.10.

The app shows no portal codes, so it does not bundle the NMS Glyphs Mono font. The icons in `src/components/Icons.tsx` are shapes from [Lucide](https://lucide.dev) (ISC licence; the notice is in that file).
