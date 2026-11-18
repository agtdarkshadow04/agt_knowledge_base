# AGT Knowledge Base

> **AI Disclosure:** This software was created using generative AI.

AGT Knowledge Base is the knowledge base of the Alliance of Galactic Travellers community: members write, review and organize articles, and visitors browse the public ones. Readers get search, tags, filters, safe Markdown with linked tables of contents, and downloads; Editors write articles and compare revisions; Moderators also protect, pin, verify, restore and delete articles and manage tags; and a single installation Admin manages member accounts, settings, backups and logs from a separate panel at `/admin`. It is fully self-hosted: it uses no cloud service and no CDN, the server makes no outbound requests unless the Admin turns on [AGT sign-in](#agt-sign-in) (then only to the configured AGT IAM service), and the browser loads everything from your server except images that authors link in articles. All data lives on your machine, in its PostgreSQL 18 database (articles, revisions, tags, accounts, settings and the logs) and in the app's data directory (pre-restore backups), with the settings in `config.yaml` and the secrets in `.env`.

## Contents

- [Installation](#installation)
  - [Docker Compose](#docker-compose)
  - [Local installation (Ubuntu/Debian)](#local-installation-ubuntudebian)
  - [TLS and reverse proxies](#tls-and-reverse-proxies)
  - [Upgrading](#upgrading)
  - [Rolling back](#rolling-back)
- [First run](#first-run)
- [Configuration reference](#configuration-reference)
- [Admin dashboard](#admin-dashboard)
- [Architecture](#architecture)
- [Roles and editing rules](#roles-and-editing-rules)
- [AGT sign-in](#agt-sign-in)
- [Using the knowledge base](#using-the-knowledge-base)
- [API](#api)
- [Backup & restore](#backup--restore)
- [Logs](#logs)
- [Content safety](#content-safety)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Credits](#credits)

## Installation

Installations run released versions (VER-13): every method below checks out a release tag, never `main`. The releases, with their upgrade notes, are listed on the [Releases page](https://github.com/agtdarkshadow04/agt_knowledge_base/releases) and in [`CHANGELOG.md`](CHANGELOG.md); in the commands, replace `vX.Y.Z` with the latest one. These instructions are for 2.0.0 and later; each release's own README describes that release.

### Docker Compose

The Compose stack has two services: `knowledge-base` (the app, one image built from this repository) and `db` (PostgreSQL 18). The app's files live in the `knowledge-base-data` volume (`/app/data`: pre-restore backups and the failed-restore marker) and the database in `knowledge-base-db`. The app container runs as the unprivileged `node` user with a read-only root filesystem, a `tmpfs` at `/tmp` and `no-new-privileges`; only its data volume is writable.

1. Install [Docker Engine](https://docs.docker.com/engine/install/) with the [Compose plugin](https://docs.docker.com/compose/install/), then clone the repository and check out the latest release:

   ```bash
   git clone https://github.com/agtdarkshadow04/agt_knowledge_base.git
   cd agt_knowledge_base
   git checkout vX.Y.Z   # the latest release
   ```

2. Create the configuration and the two secret files:

   ```bash
   cp config.example.yaml config.yaml
   cp .env.example .env
   cp .env.db.example .env.db
   ```

   In `.env`, set `AGT_KNOWLEDGE_BASE_SETUP_PASSWORD` and `AGT_KNOWLEDGE_BASE_DB_PASSWORD`; in `.env.db`, set `POSTGRES_PASSWORD` (the database superuser's, which only the `db` container receives). Use independent random values, for example from `openssl rand -hex 24`. Never commit `.env` or `.env.db`. `config.yaml` must exist before the stack starts, because Compose mounts it read-only into the app container.

3. Build and start the stack:

   ```bash
   docker compose up -d --build
   docker compose ps
   ```

   On its first start the `db` service creates the `agt_knowledge_base` role and databases (`deploy/postgres-init/10-app-role.sh`). The app waits until the database is healthy, applies pending migrations at startup and then listens. `docker compose ps` reports it `healthy` once `GET /api/health` answers.

4. The site is at `http://127.0.0.1:8081` on this host only (SEC-4). To serve other machines, put a TLS proxy in front (see [TLS and reverse proxies](#tls-and-reverse-proxies)). Continue with [First run](#first-run).

Useful operations:

```bash
docker compose logs -f knowledge-base db
docker compose ps
docker compose down                # stop containers without deleting data
docker compose exec db psql -U postgres -d agt_knowledge_base   # database maintenance
```

The `knowledge-base-db` volume holds the database and `knowledge-base-data` the pre-restore backups. Do not run `docker compose down --volumes` unless you intend to delete the data permanently.

### Local installation (Ubuntu/Debian)

On Ubuntu 24.04 LTS or Debian 12 or 13, the app runs as the systemd service `agt-knowledge-base`, under its own system user, with its data in `/var/lib/agt-knowledge-base` and its configuration in `/etc/agt-knowledge-base`.

```bash
# 1. Node.js 26 from NodeSource, and build tools for native modules
curl -fsSL https://deb.nodesource.com/setup_26.x -o /tmp/nodesource_setup.sh
sudo -E bash /tmp/nodesource_setup.sh
sudo apt-get install -y nodejs git build-essential python3

# 2. PostgreSQL 18 from the PGDG apt repository (it includes pg_dump and pg_restore for backups)
sudo apt-get install -y postgresql-common
sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh
sudo apt-get install -y postgresql-18

# 3. The database role and databases (enter the role's password when asked)
sudo -u postgres createuser --pwprompt --no-superuser --no-createdb --no-createrole agt_knowledge_base
sudo -u postgres createdb --owner agt_knowledge_base agt_knowledge_base
sudo -u postgres createdb --owner agt_knowledge_base agt_knowledge_base_preview

# 4. System user and code
sudo useradd --system --home-dir /var/lib/agt-knowledge-base --shell /usr/sbin/nologin agt-knowledge-base
sudo git clone https://github.com/agtdarkshadow04/agt_knowledge_base.git /opt/agt-knowledge-base
sudo git -C /opt/agt-knowledge-base checkout vX.Y.Z   # the latest release
cd /opt/agt-knowledge-base
sudo npm ci && sudo npm run build && sudo npm prune --omit=dev

# 5. Configuration
sudo mkdir -p /etc/agt-knowledge-base
sudo cp config.example.yaml /etc/agt-knowledge-base/config.yaml
sudo cp .env.example /etc/agt-knowledge-base/.env
sudo chmod 600 /etc/agt-knowledge-base/.env
# Edit /etc/agt-knowledge-base/config.yaml: set storage.dataDir: /var/lib/agt-knowledge-base
# Edit /etc/agt-knowledge-base/.env: set AGT_KNOWLEDGE_BASE_SETUP_PASSWORD, and
#   AGT_KNOWLEDGE_BASE_DB_PASSWORD to the role's password from step 3

# 6. Service
sudo cp deploy/agt-knowledge-base.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now agt-knowledge-base
```

The service listens on `127.0.0.1:8081` and starts after PostgreSQL. Check it with `systemctl status agt-knowledge-base` and read its output with `journalctl -u agt-knowledge-base`. The unit ([`deploy/agt-knowledge-base.service`](deploy/agt-knowledge-base.service)) runs with systemd's sandboxing: a read-only system, no home directories, private `/tmp` and devices, no capabilities, and only `/var/lib/agt-knowledge-base` writable. Continue with [First run](#first-run).

### TLS and reverse proxies

The server speaks plain HTTP only (SEC-4), so a default installation is reachable only from the host it runs on: the local service listens on `127.0.0.1:8081` (`server.host`, `server.port`), and Compose publishes the app on `127.0.0.1:8081`. To serve other machines, put a TLS-terminating reverse proxy in front of it; passwords and session cookies must not travel over plaintext HTTP. The server logs one warning per process (source `security`) the first time a sign-in or setup request arrives over plain HTTP from another machine.

With [Caddy](https://caddyserver.com/docs/), which obtains and renews certificates automatically, the whole proxy configuration is [`deploy/Caddyfile.example`](deploy/Caddyfile.example):

```text
knowledge-base.example.org {
    reverse_proxy 127.0.0.1:8081
}
```

Then set `server.trustProxy` in `config.yaml` to the address the app sees the proxy connect from, and keep `session.secureCookie: auto`:

- **Local installation:** `trustProxy: 127.0.0.1`.
- **Docker Compose:** the Docker network's gateway, which is where connections to the published port come from. Find it with `docker network inspect "$(docker compose ps -q knowledge-base | xargs docker inspect --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}')" --format '{{(index .IPAM.Config 0).Gateway}}'` (for example `172.18.0.1`), then `docker compose restart knowledge-base`.

The app then takes the client address for rate limits from the `X-Forwarded-For` header the proxy sets, and the `X-Forwarded-Proto: https` it sends marks the session cookies `Secure`. Without `trustProxy` both headers are ignored, and every client shares the proxy's address for rate limits. Any other proxy (Traefik, Nginx, HAProxy) works the same way. The proxy must accept request bodies of at least `backup.maxZipBytes` (200 MiB by default) and allow several minutes for `/api/admin/restore`. Only if the proxy runs on another machine, set `server.host` (local) or the published address in `docker-compose.yml` (Docker) to an interface that proxy can reach, and restrict that port to the proxy's address with a firewall.

### Upgrading

1. Read the upgrade notes for every version between yours and the new one in [`CHANGELOG.md`](CHANGELOG.md). A major version (for example 2.0.0) can need steps of its own.
2. Download a backup from the admin panel (**Backup & restore**) and keep it: it is what [Rolling back](#rolling-back) restores.
3. Check out the new release tag and restart:

   - **Docker Compose:**

     ```bash
     git fetch --tags
     git checkout vX.Y.Z
     docker compose up -d --build --remove-orphans
     ```

     Check `docker compose ps` and `docker compose logs knowledge-base`.

   - **Local installation:**

     ```bash
     cd /opt/agt-knowledge-base
     sudo git fetch --tags
     sudo git checkout vX.Y.Z
     sudo npm ci && sudo npm run build && sudo npm prune --omit=dev
     sudo systemctl restart agt-knowledge-base
     ```

     Check `journalctl -u agt-knowledge-base`.

The new version applies pending migrations before it listens; several processes starting together take turns under a database lock. The **Server log** tab lists every migration, and the dashboard header shows the new version.

#### Upgrading from 1.x to 2.0

2.0 replaces the 1.x stack: one app container instead of Nginx, API and migration containers, PostgreSQL 18 instead of 16, new volume names, and the site on `127.0.0.1:8081` instead of port 8080. The 1.x data moves into the new database once, with `pg_dump`, and 2.0 migrates it at its first start. The 1.x containers' volumes are left alone, so going back to 1.x needs nothing but the old files. 2.0 cannot restore 1.x backup archives.

1. **On 1.x**, with the stack running: download a backup from the admin panel (**Backup & restore**), then dump the database and stop the stack:

   ```bash
   docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-acl' \
     > agt-knowledge-base-1x.dump
   docker compose down
   cp .env .env.1x && cp config.yaml config.yaml.1x
   ```

2. **Check out 2.0** and update the configuration:

   ```bash
   git fetch --tags
   git checkout v2.0.0
   cp .env.db.example .env.db
   ```

   - In `.env.db`, set `POSTGRES_PASSWORD` to a new random value.
   - In `.env`, keep `AGT_KNOWLEDGE_BASE_SETUP_PASSWORD` only if setup is not done yet, add `AGT_KNOWLEDGE_BASE_DB_PASSWORD` with a new random value, and delete `POSTGRES_*`, `APP_*`, `LOCAL_AUTH_SECRET` and `AGT_SETUP_PASSWORD`.
   - In `config.yaml`, delete `server.trustProxy: 1` (no Nginx any more) and set it for your TLS proxy instead (see [TLS and reverse proxies](#tls-and-reverse-proxies)); delete `database.user` and `database.name` if set; move any other 1.x key names to their new names (the server warns about each one).

3. **Create the 2.0 database and load the 1.x data** into it as the app role:

   ```bash
   docker compose up -d --wait db
   docker compose exec -T db pg_restore -U postgres -d agt_knowledge_base \
     --no-owner --no-acl --role=agt_knowledge_base --exit-on-error < agt-knowledge-base-1x.dump
   ```

4. **Start 2.0:** `docker compose up -d --build --remove-orphans`. It applies the 2.0 migrations, including the 1.x contract migrations that used to need `MIGRATION_TARGET_ID`, and converts the password hashes. Check `docker compose logs knowledge-base`, sign in at `/admin` with the same Admin username and password, and point your TLS proxy at `127.0.0.1:8081`. Members keep their passwords but sign in again.

5. Once everything works, delete the 1.x volumes (`docker volume ls`, then `docker volume rm <project>_agt-postgres <project>_agt-backups`) and `agt-knowledge-base-1x.dump`.

**Going back to 1.x** before step 5: `docker compose down`, `git checkout v1.0.0`, `mv .env.1x .env`, `mv config.yaml.1x config.yaml`, then `docker compose up -d`. The 1.x volumes still hold the data as it was at step 1; changes made in 2.0 since then are not carried back.

**From a 1.x installation without Docker**, the same steps apply with `pg_dump` and `pg_restore` run directly: dump the 1.x database, create the role and databases as in [Local installation](#local-installation-ubuntudebian), and load the dump with `pg_restore -d agt_knowledge_base --no-owner --no-acl --role=agt_knowledge_base`.

**From before 1.0.** The separate Admin account came with 1.0. Its migration `012_admin_account` moved the super administrator's username and password hash into the `admin` table and removed that account from `local_users` (its user ID stays in `app_users`, so authorship and revision history are unchanged), turned former `Admin`-role users into **Moderators** and former `Standard` users into **Editors**, and signed every member out.

#### Migrating from the AWS deployment

Earlier versions were deployed on AWS (Amplify Hosting, API Gateway, Lambda, RDS, and Cognito). That code is no longer part of this repository's `main`; it is preserved on the frozen `staging` branch, which an existing AWS test deployment still builds from. Do not change or delete `staging` while that deployment is in use.

A documented procedure for moving data from an AWS deployment is planned. In outline: export the RDS database with `pg_dump`, load it into the 2.0 database as in [Upgrading from 1.x to 2.0](#upgrading-from-1x-to-20), and let the server's startup migrations bring the schema up to date. Then create a member account for each Cognito user, reusing their Cognito user ID (`sub`) as the account ID so existing authorship and revision history stay attached. Cognito cannot export passwords, so each migrated user needs a new password set by the Admin.

### Rolling back

Downgrading in place is not supported: a version refuses to start on a database whose schema is newer than it knows (DATA-4). To go back to the previous release, check out its tag, then restore the backup you took before upgrading. That backup was made by the previous version, so it has the schema that version expects. Changes made since the backup are lost.

- **Docker Compose:**

  ```bash
  docker compose stop knowledge-base
  git checkout vX.Y.Z   # the previous release
  unzip agt-knowledge-base-backup-<timestamp>.zip database.dump
  docker compose exec -T db psql -U postgres -d agt_knowledge_base -v ON_ERROR_STOP=1 -c 'DROP SCHEMA public CASCADE'
  docker compose exec -T db pg_restore -U postgres -d agt_knowledge_base --no-owner --role=agt_knowledge_base \
    --exit-on-error --single-transaction < database.dump
  docker compose up -d --build --remove-orphans
  ```

- **Local installation:**

  ```bash
  sudo systemctl stop agt-knowledge-base
  cd /opt/agt-knowledge-base
  sudo git checkout vX.Y.Z   # the previous release
  sudo npm ci && sudo npm run build && sudo npm prune --omit=dev
  unzip agt-knowledge-base-backup-<timestamp>.zip database.dump
  sudo -u postgres psql -d agt_knowledge_base -v ON_ERROR_STOP=1 -c 'DROP SCHEMA public CASCADE'
  sudo -u postgres pg_restore -d agt_knowledge_base --no-owner --role=agt_knowledge_base \
    --exit-on-error --single-transaction < database.dump
  sudo systemctl start agt-knowledge-base
  ```

`DROP SCHEMA public CASCADE` deletes the app's tables (the backup recreates them, owned by `agt_knowledge_base`); the `logs` schema, with the server log and the audit log, and the `control` schema are kept. Everyone signs in again afterwards. If the upgrade's notes say it changed the `control` or `logs` schema, the previous version refuses to start on it, and the notes say how to roll back. If `config.yaml` changed during the upgrade, put back the copy from the backup by hand (see [Backup & restore](#backup--restore)). To go back from 2.0 to 1.x, follow *Going back to 1.x* in [Upgrading from 1.x to 2.0](#upgrading-from-1x-to-20) instead.

## First run

Open `/admin` (through your proxy, or `http://127.0.0.1:8081/admin` on the host) to create the Admin account. A fresh installation shows a setup screen that asks for the one-time `AGT_KNOWLEDGE_BASE_SETUP_PASSWORD` from `.env`, then the Admin username and a new password (at least 12 characters, including uppercase, lowercase, a number, and a symbol, and different from the setup password). Without `AGT_KNOWLEDGE_BASE_SETUP_PASSWORD`, setup is refused, so nobody can claim a fresh installation by reaching it first (AUTH-5).

Once setup is complete, remove the setup password and restart; until then the server logs a warning at every start and the admin panel shows a reminder (AUTH-6):

- **Docker Compose:** delete the `AGT_KNOWLEDGE_BASE_SETUP_PASSWORD` line from `.env`, then `docker compose up -d`.
- **Local installation:** delete it from `/etc/agt-knowledge-base/.env`, then `sudo systemctl restart agt-knowledge-base`.

Then create member accounts under **Users** in the admin panel. Members sign in to the knowledge base with the header's sign-in button (`/?view=login`).

## Configuration reference

Configuration comes from three places (CFG-1): `config.yaml` for every setting that is not secret, `.env` for secrets, and the admin panel's **Settings** tab for the dashboard-editable keys below.

Compose mounts `config.yaml` read-only at `/app/config.yaml`, and the local installation reads `/etc/agt-knowledge-base/config.yaml` (the server reads `AGT_KNOWLEDGE_BASE_CONFIG_FILE`, default `./config.yaml`). [`config.example.yaml`](config.example.yaml) documents every key and its default. The file is validated when the server starts: an unknown key or an invalid value stops it with an error naming the key (for example `Invalid /app/config.yaml: server.prot: Unexpected property`), and a missing file means "all defaults" and logs a warning. The server never writes it. Changes take effect when the server restarts (`docker compose restart knowledge-base`, or `sudo systemctl restart agt-knowledge-base`).

**Precedence.** A dashboard-editable key resolves to the value in `config.yaml` if the file sets it, otherwise the value saved in the dashboard, otherwise the default. **The configuration file always wins**: the dashboard shows such a key read-only, marked "Set in the configuration file", the API rejects changes to it with HTTP `409` naming the key, and no settings write, migration or backup restore can override it.

### Keys set only in `config.yaml`

| Key | Default | Description |
| --- | --- | --- |
| `server.host`, `server.port` | `127.0.0.1` (`0.0.0.0` in the Docker image), `8081` | API listener |
| `server.trustProxy` | `false` | The TLS proxy to trust for `X-Forwarded-For` and `X-Forwarded-Proto`: `true`, or the address it connects from as an IP or CIDR (string or list); see [TLS and reverse proxies](#tls-and-reverse-proxies) |
| `server.logLevel` | `info` | What the server writes to standard output: `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`. The server log always receives `info` and above |
| `storage.dataDir`, `storage.backupsDir` | `data`, `backups` | Persistent files (DATA-10), relative to the working directory: `/app/data` in Docker (the `knowledge-base-data` volume); set `/var/lib/agt-knowledge-base` for a local installation. Pre-restore backups and upload scratch files go to `dataDir/backupsDir`, the failed-restore marker to `dataDir` |
| `database.host`, `.port`, `.name`, `.user`, `.ssl` | `localhost` (or `AGT_KNOWLEDGE_BASE_DATABASE_HOST`), `5432`, `agt_knowledge_base`, `agt_knowledge_base`, `false` | PostgreSQL connection; the password is `AGT_KNOWLEDGE_BASE_DB_PASSWORD` |
| `database.previewName` | `agt_knowledge_base_preview` | The restore preview database, owned by the app role; every preview empties it |
| `session.ttlHours` | `12` | Sign-in lifetime (1–168 hours), for the Admin and for members |
| `session.secureCookie` | `auto` | `Secure` attribute of the session cookies: `auto` (when a trusted proxy reports HTTPS), `true` or `false` |
| `rateLimits.login` | 10 per 15 minutes | Member sign-in, AGT sign-in, Admin sign-in and Admin password changes, each counted separately |
| `rateLimits.setup` | 10 per 15 minutes | First-run setup |
| `rateLimits.adminUploads` | 120 per 15 minutes | Backup restore uploads |
| `backup.preRestore.keep` | unset (keep all) | How many pre-restore backups to keep |
| `iam.baseUrl` | unset | The AGT IAM address for [AGT sign-in](#agt-sign-in): `https://`, or `http://` only to `localhost` or a loopback address |
| `iam.appId` | unset | This app's registered App ID in AGT IAM |
| `iam.timeoutSeconds` | `10` | Seconds to wait for AGT IAM before an AGT sign-in fails (1–30) |
| `iam.defaultRole`, `iam.roleMap` | `Editor`, `{}` | The role an AGT member gets from their AGT permission tier: `roleMap` maps a tier to `Editor` or `Moderator`, and `defaultRole` covers the tiers it does not list |

### Dashboard-editable keys

| Key | Default | Description |
| --- | --- | --- |
| `site.title`, `site.subtitle` | `AGT Knowledge Base`, the default subtitle | Branding |
| `site.supportUrl` | `https://www.nms-agt.com/support` | Support link (an absolute `http:` or `https:` URL) |
| `articles.defaultVisibility` | `Internal` | Default visibility of new articles |
| `access.allowPublicBrowsing` | `true` | Whether visitors who are not signed in can browse public articles |
| `backup.maxZipBytes` | `209715200` (200 MiB; 1024 to 2 GiB) | Largest backup upload |
| `backup.maxUncompressedBytes` | `1073741824` (1 GiB; 1024 to 8 GiB) | Largest uncompressed archive contents |
| `backup.maxEntries` | `10000` (1 to 100000) | Most entries in an uploaded archive |
| `logs.serverRetentionDays`, `logs.serverMaxEntries` | `30`, `100000` | How long and how many server log entries are kept (1–3650 days, 1000–10000000 entries) |
| `logs.auditRetentionDays`, `logs.auditMaxEntries` | `365`, `1000000` | How long and how many audit log entries are kept (30–3650 days, 10000–10000000 entries) |
| `iam.enabled` | `false` | Whether members can sign in with their AGT account ([AGT sign-in](#agt-sign-in)). Switching it off signs every AGT member out |

**Deprecated keys** (still accepted until 3.0.0; the server logs a warning for each one it finds): `site.applicationName` and `site.applicationSubtitle` (now `site.title` and `site.subtitle`), `backup.maxBytes` (now `backup.maxZipBytes`), `adminSession.secureCookie` (now `session.secureCookie`), `adminSession.ttlHours` (the Admin lifetime, overriding `session.ttlHours`), `rateLimits.adminLogin` and `rateLimits.adminPassword` (overriding `rateLimits.login` for those routes), `server.frontendOrigin` (when `https://`, makes the session cookies `Secure` under `auto`), and a number of proxy hops as `server.trustProxy` (the 1.x setting for the bundled Nginx). A deprecated key next to its new name stops the server.

### Environment variables

Environment variables are only for secrets and for values the launcher sets (CFG-2). Secrets go in `.env`:

| Variable | Purpose |
| --- | --- |
| `AGT_KNOWLEDGE_BASE_SETUP_PASSWORD` | One-time password for creating the Admin at `/admin`; ignored once the Admin exists. Remove it after setup |
| `AGT_KNOWLEDGE_BASE_DB_PASSWORD` | Password of the `agt_knowledge_base` database role (never a superuser) |
| `AGT_KNOWLEDGE_BASE_IAM_API_KEY` | Optional: this app's AGT IAM API access key, for [AGT sign-in](#agt-sign-in). Sent only to `iam.baseUrl`, never logged or shown |

Set by the Dockerfile or Compose file, or for development: `AGT_KNOWLEDGE_BASE_CONFIG_FILE` (path of `config.yaml`), `AGT_KNOWLEDGE_BASE_SERVER_HOST` (listen address when `server.host` is not set; the image sets `0.0.0.0`), `AGT_KNOWLEDGE_BASE_DATABASE_HOST` (database host when `database.host` is not set; Compose sets `db`), `AGT_KNOWLEDGE_BASE_STATIC_DIR` (path of the built client), and `NODE_ENV`.

With Docker Compose, `.env.db` holds `POSTGRES_PASSWORD`, the database superuser's password, which only the `db` container reads (DEP-3); the `db` container also receives `AGT_KNOWLEDGE_BASE_DB_PASSWORD` to create the app role on its first start.

**Deprecated variables** (still read until 3.0.0, each with a startup warning): `AGT_SETUP_PASSWORD`, `CONFIG_FILE`, `DB_PASSWORD`, `DATABASE_URL` (use the `AGT_KNOWLEDGE_BASE_` names above), `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DATABASE_SSL` (use `database.*` in `config.yaml`), and `AUTH_MODE` (only `local` is accepted). `MIGRATION_TARGET_ID` is no longer used.

`API_HOST`, `API_PORT`, `APP_ORIGIN`, `LOCAL_FRONTEND_ORIGIN`, and `LOCAL_AUTH_SESSION_HOURS` are no longer read: use `server.*` and `session.ttlHours` in `config.yaml`. `LOCAL_USER_PASSWORD` and `AGT_KNOWLEDGE_BASE_LOCAL_USER_PASSWORD` went with the member-recovery command, and Compose no longer reads `POSTGRES_USER`, `POSTGRES_DB`, `POSTGRES_BIND_ADDRESS`, `POSTGRES_PORT`, `APP_BIND_ADDRESS` or `APP_PORT`. `LOCAL_AUTH_SECRET` is no longer used (members have cookie sessions); the server logs a reminder while it is still set.

## Admin dashboard

The admin panel is a separate page reachable only by visiting `/admin` directly; nothing in the knowledge base links to it, and its code is not part of the member app. It has its own sign-in and session, independent of member sign-in: signing in or out of one never affects the other. Its gear button sets the language, time zone and text size, as in the knowledge base. Its tabs:

- **Users** creates, updates, deactivates, resets passwords for, and deletes member accounts (Editor or Moderator). Members who sign in with their AGT account are marked **AGT account**, with their AGT traveller ID and permission tier; AGT IAM sets their name and role, so they can only be deactivated or deleted here.
- **Data** shows archive statistics and the inventory of every article at every visibility level.
- **Settings** edits the [dashboard-editable keys](#dashboard-editable-keys). Settings defined in `config.yaml` are shown read-only, marked "Set in the configuration file". The **AGT sign-in** section switches [AGT sign-in](#agt-sign-in) on or off and says what the server still needs for it.
- **Backup & restore** downloads and restores backups (see [Backup & restore](#backup--restore)).
- **Server log** shows, filters, searches, exports and clears the server log (see [Logs](#logs)). It shows a badge while there are unseen warnings or errors.
- **Audit log** shows, filters, searches and exports the audit log.
- **Account** changes the Admin password. It requires the current password and signs out every other Admin session.
- **API** renders the API reference from the server's OpenAPI document (`/api/openapi.json`).

The dashboard header shows the app version.

## Architecture

```text
Browser --HTTPS--> TLS proxy (Caddy, ...) --HTTP--> knowledge-base: Node.js (Fastify) --> db: PostgreSQL 18
                                                    127.0.0.1:8081                       (own volume)
                                                    serves the React/Vite UI and /api/*,
                                                    applies schema migrations at startup
```

The browser never connects to PostgreSQL and contains no database credential. One Node.js server serves the member app (`index.html`), the admin panel (`admin.html`, only at `/admin`), and the API under `/api/`. Member accounts and their scrypt password hashes are stored in `local_users`, and members sign in with cookie sessions. The installation Admin is stored separately, in the single-row `admin` table, and signs in with a cookie session that works only for the admin API. The API is the authorization boundary: it checks the session, role, visibility, and protection before reading or changing data. `created_at`, `created_by`, `updated_at`, `modified_by`, pinning, protection, and version fields are server-owned. The server connects to PostgreSQL as the non-superuser role `agt_knowledge_base`, which owns only the app's database and its restore preview database, and refuses to start as a superuser. With Docker Compose, PostgreSQL is reachable only on the stack's private network; its port is never published.

Members and the Admin sign in with cookie sessions: a random 32-byte token in an `HttpOnly`, `SameSite=Strict`, `Path=/` cookie (`agt_knowledge_base_member_session` for members, `agt_knowledge_base_session` for the Admin) that page scripts cannot read. Only its SHA-256 is stored (`member_sessions`, `sessions`), so signing out revokes it on the server, and sessions last `session.ttlHours`. Every state-changing request must also carry an `x-agt-request: 1` header. The cookies are marked `Secure` when a trusted proxy reports HTTPS (see [TLS and reverse proxies](#tls-and-reverse-proxies)); set `session.secureCookie` to `true` or `false` to override this. The member cookie is ignored on admin routes, and the Admin cookie on member routes. Changing a member's role, deactivating them, setting their password or deleting them ends all of their sessions.

Schema changes are numbered SQL files, `server/migrations/NNNN_<name>.sql` (DATA-3). The server applies every pending one at startup, each in its own transaction, under a PostgreSQL advisory lock, and records it in `schema_migrations (version, name, applied_at)` (DATA-4, DATA-11). It refuses to start when the database has a migration it does not know (a newer schema) or when it is connected as a superuser.

## Roles and editing rules

| User | Visible articles | View/compare history | Create | Set visibility | Edit unprotected | Edit protected | Pin, protect, verify | Restore | Delete | Manage tags |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Public | Public (legacy or AGT level 0) | No | No | No | No | No | No | No | No | No |
| Editor | Public, Internal, Private | Yes | Yes | Public, Internal, or AGT levels 0–1 on unprotected articles | Yes | No | No | No | No | No |
| Moderator | All | Yes | Yes | Any level | Yes | Yes | Yes | Yes | Yes | Yes (**Tags** page) |

Editors and Moderators are member accounts that sign in from the sign-in button in the header (`/?view=login`). The **Admin** is not a member role: it is the single installation account, which signs in only at `/admin` and manages member accounts, settings, statistics, and backups. It cannot sign in to the knowledge base or write articles; use a separate member account for that. No API call or page can give a member account administrator privileges.

AGT-standard visibility is stored as numeric levels: `0` Public (`#2aff00`), `1` Private (`#00f4ff`), `2` Restricted (`#f198e2`), `3` Top Secret (`#fd0303`), `4` SLT Restricted (`#ff9300`), and `5` SCC Restricted (`#3287f0`). Public visitors and Editors can read level 0, Editors can also read level 1, and levels 2–5 are Moderator-only. The legacy text values Public, Internal, and Admin remain supported with their existing access rules and colors; legacy `Admin` articles are shown as "Admin (legacy)" and are visible to Moderators.

Updates, restores, and deletes carry the article version. PostgreSQL applies the mutation only when that version still matches, returning HTTP `409` instead of silently overwriting a concurrent edit. Restoration creates a new latest revision rather than rewriting history.

## AGT sign-in

Besides their local account, members can sign in with their AGT account (Traveller Name and password), checked by the AGT Identity & Authorization Hub (AGT IAM). It is off by default; the Admin switches it on with the `iam.enabled` setting, a true/false value in the **Settings** tab (or in `config.yaml`, which then wins).

To set it up:

1. Register the Knowledge Base as an app in AGT IAM, with the `auth:verify` capability, and note its App ID and API access key.
2. In `config.yaml`, set `iam.baseUrl` (for example `https://iam.nms-agt.com`) and `iam.appId`, and map the AGT permission tiers to roles with `iam.roleMap` (for example `{ Moderator: Moderator }`; other authorized tiers get `iam.defaultRole`, `Editor` by default).
3. In `.env`, set `AGT_KNOWLEDGE_BASE_IAM_API_KEY` to the API access key, then restart.
4. In the admin panel, **Settings** → **AGT sign-in**: tick "Let members sign in with their AGT account" and save. The section says "AGT IAM is configured" once nothing is missing.

The sign-in page then offers **Local account** and **AGT account**. What happens at an AGT sign-in:

- The server sends the Traveller Name, the password and the App ID to `POST <iam.baseUrl>/api/v1/auth/verify` with the API key, and nowhere else. It never stores, caches or logs the password, and never retries. This is the only outbound request the server makes (a deviation from the AGT spec's SEC-14, recorded in `AGENTS.md`).
- A traveller AGT IAM does not authorize for this app (tier `NOACCESS` or `NONE`) is refused with a message saying so; nothing is created.
- The first sign-in creates a member account linked to the AGT traveller ID, without a local password; the Traveller Name becomes its name. Every sign-in sets its role from the permission tier again; a changed role signs its other sessions out.
- The session lasts `session.ttlHours`, or until AGT IAM's own token expires if that is sooner. Then the member signs in again.
- The Admin can deactivate or delete an AGT member like any member, but not rename it, change its role or set a password: AGT IAM owns those.
- Switching `iam.enabled` off signs every AGT member out at once. Their accounts and articles stay, and they can sign in again once it is back on. Local accounts are never affected.

Traveller Names and passwords may be up to 42 characters and may contain any character except control characters such as line breaks; quotes, commas, `+` and `\` are sent exactly as typed. If AGT IAM refuses the app itself (wrong API key or App ID, an inactive app, a missing capability), members see "AGT sign-in is unavailable" and the server log says why, without the key.

## Using the knowledge base

The article list pages through results with a **Load more** button and keeps its search, sort and filters (visibility, tag, pin status, verification) in the address. Articles show a linked table of contents, their tags and status (visibility, verified, pinned, protected), and can be downloaded as Markdown or PDF. Editors and Moderators compare any two of an article's five most recent revisions; Moderators restore one as a new revision.

Moderators manage canonical tags and clean up orphaned tag references on the **Tags** page (`/?view=tags`), linked in the header for Moderators only.

The **Settings** dialog (the gear button in the header) keeps a few preferences in this browser only: the **language** (English, French, German, Spanish, Brazilian Portuguese, Italian, Thai, Simplified Chinese, Hindi or Japanese; English until the reader picks another), the **time zone** that dates and times are shown in (the browser's own, or a fixed UTC offset), the **text size** (1× to 2×), the search-results view, and whether the article page offers PDF and Markdown downloads. The member app and the admin dashboard share one `localStorage` object, `agt_knowledge_base_settings`; preferences saved by 1.x under `agt-*` keys are moved there once. Dates, times, numbers and sizes follow the chosen language's conventions. The interface is translated; article content and the API's English `message` texts are not (the UI shows its own text for each error code).

Pages are addressed with query parameters on `/`: `/?article=<id>` opens an article, `&view=history` and `&view=edit` its history and editor, and `/?view=new`, `/?view=tags` and `/?view=login` the other pages. Links in the 1.x form (`/articles/<id>`, `/articles/<id>/history`, `/articles/<id>/edit`, `/articles/new`, `/tags`, `/login`) still work: the server redirects them to the new address. These redirects are removed in 3.0.0.

## API

The API is documented in [`docs/API.md`](docs/API.md), which covers member and Admin authentication, the CSRF header, optimistic concurrency, roles and visibility, pagination, error codes, deprecated paths, and limits, with `curl` examples. Per-route detail is in the OpenAPI 3.1 document the server generates from its route schemas, served at `GET /api/openapi.json`; the admin panel renders it in its **API** tab. `GET /api/health` answers `{ "status": "ok" }` while the API and its database are up.

## Backup & restore

The Admin backs up and restores the installation from **Backup & restore** in the admin panel.

**Download backup** creates `agt-knowledge-base-backup-<timestamp>.zip` (for example `agt-knowledge-base-backup-2026-11-10T06-30-59-123Z.zip`). It contains:

- `database.dump`: a `pg_dump` custom-format dump of the app's `public` schema (every article, revision, tag, author record, member account, the Admin account and the dashboard settings), without any session rows;
- `config.yaml`, if the installation has one, byte for byte;
- `manifest.json`: the format (`agt-knowledge-base-backup`, format version 1), the application version, the database schema version, the creation time, and each file's size and SHA-256 checksum.

Sessions, `.env`, the `control` schema (the shared backup and restore state) and **the logs are never included** (see [Logs](#logs)). While the dump is taken, reads continue and writes wait (for at most 30 seconds, then they answer `503`), so the dump is one consistent snapshot. **Backups contain the Admin and member password hashes and every restricted article**: store them as securely as the database itself, and never commit them. **Restore only backups made by an AGT Knowledge Base installation you trust**: a restore runs the SQL in the dump, within the limits below.

**Restoring is two steps: preview, then restore.** Uploading a backup first previews it and changes nothing:

- The archive may contain only `manifest.json`, `database.dump` and `config.yaml` (no other paths, directories, symlinks or `..`), within the `backup.maxZipBytes`, `backup.maxEntries` and `backup.maxUncompressedBytes` limits (checked while decompressing), and every checksum must match the manifest.
- The dump's table of contents is checked against an allowlist: only the app's tables, their data, sequences, defaults, constraints and indexes in the `public` schema. A function, trigger, view, extension, permission change or any other schema rejects the archive.
- The dump is then restored into the separate preview database (`database.previewName`, default `agt_knowledge_base_preview`), which is emptied before and after. That checks that it restores, its schema version, that every table exists and that the Admin's password hash could sign in.
- The preview shows per-table counts, whether the restore upgrades an older schema, warnings, a line diff between the backup's `config.yaml` and the current one, and the settings that will be ignored.

Then:

- **Versions.** Backups from an older version are migrated after the restore; backups from a newer version (a newer format or schema) are refused. **Backups made by 1.x** (a `database.json` file) are refused: restore them with 1.x, then upgrade to 2.0.
- **Maintenance.** The restore checks the upload again, then puts every API process in maintenance: requests in progress finish (for at most 30 seconds, or the restore is abandoned with `409`), and every other API request answers `503` until it ends. `GET /api/health` answers `{"status":"maintenance"}` meanwhile, so Docker does not restart the container.
- **Pre-restore backup.** The current data is then saved as `pre-restore-backup-<timestamp>.zip` (with its restore list, `pre-restore-backup-<timestamp>.list`) in `storage.dataDir/storage.backupsDir` (in the `knowledge-base-data` volume with Docker). If it cannot be written, nothing is restored. Pre-restore backups are kept unless `backup.preRestore.keep` is set; then the oldest beyond that number are deleted, each with its `.list`, after a new one is written.
- **Rollback.** The database is replaced with `pg_restore` in a single transaction, migrated and checked. If any of that fails, the pre-restore backup is restored, and the restore answers "The restore failed and was rolled back. Nothing was changed." If even that fails, see [Recovering from a failed restore](#recovering-from-a-failed-restore).
- **Logs** are not changed by a restore: the audit log keeps its record of the restore and of everything before it.
- Afterwards every member and the Admin are signed out; sign in at `/admin` with the Admin account stored in the backup.

**`config.yaml` is never restored** (BAK-5). The preview offers the backup's copy for download, with a diff against the current file, and lists the dashboard settings in the backup that will be dropped because the current file defines their keys. To restore it by hand, replace the current file with the backup's copy (unzip `config.yaml` from the archive) and restart: `docker compose restart knowledge-base`, or copy it to `/etc/agt-knowledge-base/config.yaml` and `sudo systemctl restart agt-knowledge-base`.

The server runs `pg_dump` and `pg_restore` itself, as the `agt_knowledge_base` role, with the password only in the child's environment. They must be at least the PostgreSQL server's major version; the image ships the PostgreSQL 18 client tools for the Compose stack's `postgres:18`, and the local installation's `postgresql-18` package includes them. The role must own the preview database (both installation methods create it), and the server refuses to start if `database.previewName` names the app's own database.

The API checks the Admin session before reading a backup upload and enforces `backup.maxZipBytes` itself while streaming it to disk. A TLS reverse proxy in front must allow request bodies of at least `backup.maxZipBytes` too, and timeouts of several minutes for `/api/admin/restore`.

For host-level or scheduled backups, use `pg_dump` from the running `db` container (locally: `sudo -u postgres pg_dump ...` with the same options):

```bash
docker compose exec -T db pg_dump -U postgres -d agt_knowledge_base --format=custom --schema=public \
  > "agt-knowledge-base-$(date +%Y%m%d-%H%M%S).dump"
```

Keep backups off the host and test restores periodically. To restore such a dump into the stack, replacing the current data:

```bash
docker compose stop knowledge-base
docker compose exec -T db pg_restore -U postgres -d agt_knowledge_base --clean --if-exists --no-owner --role=agt_knowledge_base \
  < agt-knowledge-base-YYYYMMDD-HHMMSS.dump
docker compose up -d
```

Restoring a `pg_dump` backup from an older version is safe: on start, the server applies any migrations the backup is missing.

## Logs

The server keeps two logs in the `logs` schema of its database, shown in the admin panel. **Neither log is part of a backup, and a restore never changes them**, so the audit log keeps its record of a restore and of everything before it.

- **Server log:** what the server did by itself: startup (version, schema versions, address, configuration file), configuration warnings such as the setup-password reminder, every migration, backups and restores, each retention run that deleted entries, and every unexpected error with its message and stack (source `http`, with the request ID). The Admin can filter, search, export and clear it. Everything at `info` and above also goes to standard output (`docker compose logs knowledge-base`, or `journalctl -u agt-knowledge-base`), and `server.logLevel` controls only that output.
- **Audit log:** what users did: every request that changes something (articles, tags, member accounts, settings with their old and new values, backups and restores, sign-ins, sign-outs, setup and password changes, whether they succeeded or not), backup downloads and log exports, every denied request to the admin API, and every rate-limited request. Each entry records the time, whether the actor was the Admin, a member or anonymous, the Admin's or member's username, the action (the API operation), the route, the affected article, tag or member, the outcome and status code, the request ID, and a short summary of the change. Article bodies, passwords and other submitted values are never recorded, and a failed request records only which fields were invalid. Identical failures from the same address within a minute are counted in one entry. The Admin can filter, search and export it, but no one can edit or clear it through the app.

**Retention.** Server log entries are kept for `logs.serverRetentionDays` (30 days by default) and audit log entries for `logs.auditRetentionDays` (365 days, at least 30). A retention job deletes older entries at startup and every hour, and then the oldest entries beyond `logs.serverMaxEntries` and `logs.auditMaxEntries` (in the audit log, denied, rate-limited and failed requests go before successes). All four are [dashboard-editable](#dashboard-editable-keys).

**Export.** Both tabs export the entries that match their filters as JSON Lines or CSV files named `agt-knowledge-base-<server|audit>-log-<timestamp>.<ext>`. CSV cells that a spreadsheet would treat as a formula start with a `'`.

**Privacy (LOG-23).** The audit log never stores IP addresses. It stores a pseudonymous hash of the client address: the first 16 hex characters of an HMAC-SHA256 with a random key kept in the log store (for IPv6, of the /64 prefix). The hash can tell that two requests came from the same network address without revealing the address. These hashes, with Admin and member usernames and the identifiers of the articles, tags and members acted on, are kept for `logs.auditRetentionDays`. The app has no anonymous writes, so it collects no other identifiers.

## Content safety

- Articles are Markdown, written in the rich editor or as plain Markdown. The API rejects raw HTML, JSX tags, and MDX `import` / `export` statements. MDXEditor is used as a Markdown authoring surface only; content is never executed as MDX.
- Article writes are validated with Zod and capped at 250,000 characters and 12 tags.
- Markdown is rendered by one component, `src/components/Markdown.tsx` (`react-markdown` with GFM): raw HTML is shown as text, only `http:`/`https:` and same-site links and images are kept, external links open in a new tab with `rel="noopener noreferrer"`, and external images load lazily without a referrer. Images that authors link in Markdown are loaded by visitors' browsers directly from their hosts; the server itself makes no outbound requests, except to AGT IAM for [AGT sign-in](#agt-sign-in) while the Admin has it switched on.
- Every response carries a strict Content-Security-Policy (no inline scripts or styles, no external hosts except images in Markdown), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy` and `Cross-Origin-Opener-Policy`, and API and HTML responses are never cached. The API sends no CORS headers.
- SQL values are parameterized; requested sort fields are mapped through a fixed allowlist. PostgreSQL timestamps are `timestamptz` values generated by the server and serialized as UTC ISO 8601.
- Passwords are hashed with scrypt (`N = 2^15, r = 8, p = 1`, stored as `scrypt$N$r$p$salt$hash`); a stored hash in any other format can never verify. Member and Admin sessions use random tokens stored only as SHA-256 hashes, in `HttpOnly`, `SameSite=Strict` cookies, with a CSRF header required on every write. Sign-in, setup, Admin password changes and backup uploads are rate-limited by the API.
- API errors do not return database details; a rejected backup says which check failed, never the `pg_restore` output, which the server logs instead. The API logs unexpected failures, with their request ID, to the server log and to standard output, and never logs passwords, tokens, cookies, request bodies or raw IP addresses (see [Logs](#logs)).
- Backups are available only to the Admin. Archives are checksummed and size- and path-checked, their dump's table of contents is allowlisted, and they are previewed in a separate database before restoring. A restore runs in maintenance, in a single transaction after a pre-restore backup, rolls back if anything fails, and signs everyone out. The app role is not a superuser, so even an allowed dump can only create and fill tables in the two databases it owns.

## Development

Development needs Node.js 26 and npm 11.20 or newer within npm 11, and a PostgreSQL 18 server (a container is enough). Read [`AGENTS.md`](AGENTS.md) for the conventions and change checklists, which apply to human contributors too, and the pinned [AGT Web Application Specification](docs/agt-webapp-spec.md) (v6.0.1) the app follows. See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines.

1. Install dependencies and create local configuration:

   ```bash
   npm ci
   cp .env.example .env.local
   cp config.example.yaml config.yaml
   ```

   In `.env.local`, set `AGT_KNOWLEDGE_BASE_SETUP_PASSWORD` and `AGT_KNOWLEDGE_BASE_DB_PASSWORD` to any values you like. Pre-restore backups go to `./data/backups`. Backups need the PostgreSQL 18 client tools (`pg_dump`, `pg_restore`) on the `PATH`.

2. Start a development PostgreSQL 18 on `127.0.0.1:5432`. On its first start, `deploy/postgres-init/10-app-role.sh` creates the `agt_knowledge_base` role (with `AGT_KNOWLEDGE_BASE_DB_PASSWORD` from `.env.local`) and its databases:

   ```bash
   set -a && source .env.local && set +a
   docker run -d --name agt-knowledge-base-dev-db -p 127.0.0.1:5432:5432 \
     -e POSTGRES_PASSWORD=local-development-superuser-password -e AGT_KNOWLEDGE_BASE_DB_PASSWORD \
     -v "$PWD/deploy/postgres-init:/docker-entrypoint-initdb.d:ro" postgres:18-bookworm
   ```

3. Start the API and Vite in separate terminals:

   ```bash
   set -a && source .env.local && set +a && npm run dev:server
   npm run dev
   ```

   Open `http://localhost:5173/admin` and complete first-run setup with the setup password from `.env.local`, then create member accounts under **Users**. Vite proxies `/api` to the API on `127.0.0.1:8081`, so the browser sees a single origin, as in production. Rerun `npm run dev:server` after changing server code.

4. The server tests and the browser tests run against a real PostgreSQL 18, through a role that may create databases and is used only by tests (TEST-3). Without it, `npm run check` fails. With the development database above:

   ```bash
   docker exec -i agt-knowledge-base-dev-db psql -U postgres -c "CREATE ROLE agt_test LOGIN NOSUPERUSER CREATEDB NOCREATEROLE PASSWORD 'agt-test-password'"
   export AGT_KNOWLEDGE_BASE_TEST_DATABASE_URL=postgres://agt_test:agt-test-password@127.0.0.1:5432/postgres
   npx playwright install --with-deps chromium   # once: the browser for the browser tests
   ```

| Command | What it does |
| --- | --- |
| `npm run check` | Lint (`tsc -b`), the shared-library and server tests, and the production build. Run it before every commit |
| `npm run lint` | Type-checks the app, the build scripts and the server (strict, no unused symbols) |
| `npm test` | The shared-library tests (`src/lib/*.test.ts`) and the server tests (`server/test/*.test.ts`), with Node's test runner; each server test database is created through the test role and dropped afterwards |
| `npm run test:e2e` | Builds, then runs the browser tests in Chromium against the real server on a fresh database (`agt_knowledge_base_e2e`): every page, axe WCAG 2.2 AA, layouts from 300 px and at the 2× text size, the dialogs from the keyboard, and the Content-Security-Policy |
| `npm run build` | The client (`dist/`) and the server bundle (`dist-server/index.mjs`) |
| `npm run dev:server` | Builds and starts the API on `127.0.0.1:8081` with the variables from `.env.local`, applying pending migrations first |
| `npm run dev` | The Vite dev server on `:5173`, proxying `/api/` to the API |

GitHub Actions runs `npm run check` and `npm run test:e2e`, each with a PostgreSQL 18 service, and builds the image and runs the Docker Compose stack until it is healthy, for every pull request and every push to `main` (`.github/workflows/ci.yml`). Releases follow [`docs/RELEASING.md`](docs/RELEASING.md).

| Path | Contents |
| --- | --- |
| `src/` | Member UI: `components/` (pages, dialogs, icons), `translations.ts` (the 10 locales), `agt-base.css` (the AGT base stylesheet), `styles.css` |
| `src/admin/` | Admin panel (separate entry: `admin.html`), its strings (`i18n.ts`) and `admin.css` |
| `src/lib/` | Framework-free code: validation and API types shared with the server, the API client, deep links, preferences, formatting |
| `public/` | AGT logo, fonts and font licences, copied unmodified from the spec (UI-15) |
| `server/` | Fastify API: entry point, app, route table, domain services, authorization, backups, logs, PostgreSQL repositories |
| `server/migrations/` | SQL migrations of the app, `control` and `logs` schemas |
| `server/test/` | Server tests (`node:test`), including the real-PostgreSQL tests |
| `tests/e2e/` | Browser tests (Playwright) against the real server |
| `docs/` | API guide (`API.md`), release checklist (`RELEASING.md`) and the pinned AGT web app spec |
| `deploy/` | systemd unit, Caddyfile example, PostgreSQL init script |
| `.github/` | CI workflow |

## Troubleshooting

Look at the **Server log** tab first: startup problems, warnings and every unexpected error are there, with request IDs. If the server does not start, read its standard output instead: `docker compose logs knowledge-base`, or `journalctl -u agt-knowledge-base`.

- **The server refuses to start.** The last log line says why:
  - *Invalid config.yaml*: an unknown key or invalid value, named in the message (see [Configuration reference](#configuration-reference)); a deprecated key next to its new name also stops it.
  - *The database role is a superuser*: connect as `agt_knowledge_base` (`database.user`), created as in [Installation](#installation).
  - *A newer schema*: the database was migrated by a newer version; see [Rolling back](#rolling-back).
  - *The preview database is the app's database*: set `database.previewName` to another database.
  - *A failed restore*: see [Recovering from a failed restore](#recovering-from-a-failed-restore).
  - Cannot connect to the database: check `database.*` and `AGT_KNOWLEDGE_BASE_DB_PASSWORD`, and with Compose that `db` is healthy (`docker compose ps`).
- **The setup password is missing.** `/admin` refuses setup while `AGT_KNOWLEDGE_BASE_SETUP_PASSWORD` is unset: set it in `.env` and restart (see [First run](#first-run)). Once the Admin exists, the variable is ignored; remove it.
- **A member is locked out.** The Admin resets their password or reactivates them under **Users**.
- **The Admin is locked out.** Delete the Admin account and its sessions, then run setup again:

  ```bash
  # Docker Compose
  docker compose exec -T db psql -U postgres -d agt_knowledge_base -c 'DELETE FROM sessions; DELETE FROM admin;'
  # Local installation
  sudo -u postgres psql -d agt_knowledge_base -c 'DELETE FROM sessions; DELETE FROM admin;'
  ```

  Then set `AGT_KNOWLEDGE_BASE_SETUP_PASSWORD` again, restart, and complete setup at `/admin`. Member accounts and articles are not affected. Alternatively, restore a backup whose Admin password you know.
- **"Too many requests" (`429`).** Sign-in, setup, password changes and backup uploads are rate-limited per client address ([`rateLimits.*`](#keys-set-only-in-configyaml)); wait for the time the message gives, or restart the server, which resets the counters. If every user is limited at once behind a proxy, `server.trustProxy` is not set, so all clients share the proxy's address.
- **Proxy and HTTPS.** If sign-in works but you are signed out at once behind a proxy, or the server log warns about credentials over plain HTTP, check [TLS and reverse proxies](#tls-and-reverse-proxies): the proxy must send `X-Forwarded-Proto`, and `server.trustProxy` must name its address. A backup upload that fails at the proxy needs a larger body limit and a longer timeout there.
- **"Maintenance in progress" (`503`).** A restore is running in some process, or a change waited more than 30 seconds for a backup. The UI retries by itself after a few seconds; `GET /api/health` reports `maintenance` meanwhile. If it never ends, a restore failed: see below.

### Recovering from a failed restore

If a restore fails and its rollback fails too (for example because the database became unreachable), or the process running a restore dies, the data may be half restored. The app then stays in maintenance in every process: every API request answers `503`, and the server writes `storage.dataDir/restore-failed.json` naming the pre-restore backup and records `restore_failed` in the `control.operation` row. It refuses to start while either is present (BAK-11).

Until the session expires, the Admin who started the restore can still sign in to the admin panel with that session and run another restore from **Backup & restore** (for example of the pre-restore backup). If it succeeds, the app returns to normal by itself. Otherwise, restore the pre-restore backup by hand:

1. Stop the app: `docker compose stop knowledge-base` (local: `sudo systemctl stop agt-knowledge-base`).
2. Copy the pre-restore backup and its `.list` file out of the data directory (`docker compose cp knowledge-base:/app/data/backups/. ./backups` with Docker), unzip the backup, and restore its dump with the list, as the app role:

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

4. Start the app: `docker compose up -d` (local: `sudo systemctl start agt-knowledge-base`).

The app never clears the failed state by itself because a file is missing: if only one of the two is present (for example after the container was recreated), the start-up error names the missing one; check the data before clearing both. A restore replaces the data inside PostgreSQL and sets no files aside, so there are no `*.restore-old-*` paths to clean up.

## Credits

The AGT logo and the fonts come unmodified from the [AGT Web Application Specification](https://github.com/agtdarkshadow04/agt_webapp_specification/blob/v6.0.1/assets/README.md) (v6.0.1). The logo is © Alliance of Galactic Travellers, all rights reserved, and is used only in AGT apps.

- **NMS Futura** (`public/NMSFuturaProBook_Kerned.ttf`), the interface font: by No Man's Sky Community Developers & Designers (NMSCD), designer Blend3rman (licence notice © 2020 Hector Javier Gonzalez Rivera), based on the typeface of Hello Games' No Man's Sky. Licensed under the [SIL Open Font License 1.1](public/fonts/NMSFuturaProBook-OFL.txt). Source: [NMSCD/No-Mans-Sky-Universal-Font](https://github.com/NMSCD/No-Mans-Sky-Universal-Font/blob/master/assets/font/NMSFuturaProBook_Kerned/Web-TT/NMSFuturaProBook_Kerned.ttf).
- **Twemoji Country Flags** (`public/fonts/TwemojiCountryFlags.woff2`), which shows flag emoji in articles: flag artwork by Twitter, Inc. and other contributors (Twemoji), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); font packaging © 2022 TalkJS, MIT ([licence file](public/fonts/TwemojiCountryFlags-LICENSE.md)). Source: [talkjs/country-flag-emoji-polyfill](https://github.com/talkjs/country-flag-emoji-polyfill) 0.1.10.

The app shows no portal codes, so it does not bundle the NMS Glyphs Mono font. The icons in `src/components/Icons.tsx` are shapes from [Lucide](https://lucide.dev) (ISC licence; the notice is in that file).
