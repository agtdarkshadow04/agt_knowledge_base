# Changelog

All notable changes to AGT Knowledge Base are documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html), as described in §21 of the
[AGT Web Application Specification](docs/agt-webapp-spec.md).

## [2.0.0] - 2026-11-17

### Upgrade notes

- **Building from source needs Node.js 26 and npm 11.20 or newer within npm 11.** `npm ci` now stops with an engine
  error on older versions. The Docker image includes Node.js 26
  ([#50](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/50)).
- **Development:** start the API with `npm run dev:server` instead of `npm run api:dev`, and run every check with
  `npm run check` (lint is now `tsc -b`; `npm run typecheck` is gone)
  ([#50](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/50)).
- **Docker Compose: the stack is replaced, and the data moves to PostgreSQL 18 once.** Download a backup with 1.x
  first. 2.0 runs one app container (`knowledge-base`, built from the `Dockerfile`) and `db` (`postgres:18`) with
  the new volumes `knowledge-base-data` and `knowledge-base-db`; the `web` (Nginx), `api`, `migrate` and `postgres`
  services and the `agt-postgres` and `agt-backups` volumes are no longer used. The 1.x database is copied over
  with `pg_dump` and `pg_restore` as the app role, and 2.0 migrates it at its first start; the 1.x volumes stay
  untouched, so going back to 1.x needs only the old `.env` and `config.yaml` (README, *Upgrading from 1.x to 2.0*,
  gives every command) ([#51](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/51), [#59](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/59))
- **The site moves from port 8080 to `127.0.0.1:8081`.** The app serves the web UI and the API itself, plain HTTP on
  the host's loopback interface only (SEC-4). Point your TLS proxy at `127.0.0.1:8081`, forwarding every path without
  rewriting it, and set `server.trustProxy` to the address the app sees it connect from (the Docker network's
  gateway; README, *TLS and reverse proxies*) instead of the 1.x `trustProxy: 1`. Without a TLS proxy, the site is
  reachable only from the host ([#51](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/51), [#53](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/53), [#59](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/59))
- **Secrets: `.env` holds the app's, `.env.db` the database superuser's.** Copy `.env.db.example` to `.env.db` and
  set `POSTGRES_PASSWORD`; in `.env`, set a new `AGT_KNOWLEDGE_BASE_DB_PASSWORD` (the app role's), and delete
  `POSTGRES_*`, `APP_*` and `LOCAL_AUTH_SECRET`, which Compose and the app no longer read (DEP-3, DEP-4) ([#59](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/59)).
- **Local installation without Docker** is now supported as a systemd service on Ubuntu or Debian
  (`deploy/agt-knowledge-base.service`; README, *Local installation*) (DEP-6..DEP-9) ([#59](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/59)).
- **API clients: error bodies changed.** Every error now has a snake_case `error` code (for example `not_found`,
  `validation_failed`, `conflict`), English `message`, optional `params`, and `fields` for field errors
  (`{ field, code, message, params? }`). The 1.x `code` and `issues` properties are still sent but deprecated.
  Unexpected errors answer `An unexpected server error occurred.` ([#51](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/51)).
- **API clients: a malformed ID in a path now answers `404 not_found`** instead of `400` with `INVALID_ID`,
  `INVALID_TAG_ID` or `INVALID_USER_ID` ([#51](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/51)).
- **API clients: request bodies must be JSON with `content-type: application/json`** and match the route's schema;
  a body with properties the route does not declare, or values of the wrong type, answers `400 validation_failed`
  with `fields` (unknown properties were already refused) ([#51](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/51)).
- **API clients: article lists are paged with cursors.** Without `page`, `GET /api/articles`,
  `GET /api/member/articles` and `GET /api/admin/articles` return `{ items, nextCursor, total }` with up to `limit`
  (default 50) articles; pass `nextCursor` as `cursor` for the next page. Clients that send `page` still get the 1.x
  response with `page`, `pageSize` and `totalPages`, until 3.0.0 ([#51](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/51)).
- **The API listens on port 8081 instead of 3001** (`server.port`, the app's registered port), and on `127.0.0.1`
  unless `server.host` or `AGT_KNOWLEDGE_BASE_SERVER_HOST` says otherwise; the Docker image sets `0.0.0.0`. If your
  `config.yaml` sets `server.port: 3001`, remove it ([#52](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/52)).
- **Configuration keys and environment variables have their spec names.** The 1.x names still work until 3.0.0 and
  each one used logs a deprecation warning at startup, so nothing has to change now. To silence the warnings:
  - in `config.yaml`, rename `site.applicationName` → `site.title`, `site.applicationSubtitle` → `site.subtitle`,
    `backup.maxBytes` → `backup.maxZipBytes`, `adminSession.secureCookie` → `session.secureCookie`; remove
    `adminSession.ttlHours`, `rateLimits.adminLogin` and `rateLimits.adminPassword` unless you need values other than
    `session.ttlHours` and `rateLimits.login`; remove `server.frontendOrigin` behind a TLS proxy that `trustProxy`
    trusts (the Admin cookie is then still `Secure`);
  - in `.env`, rename `AGT_SETUP_PASSWORD` → `AGT_KNOWLEDGE_BASE_SETUP_PASSWORD`;
  - in `config.yaml`, remove `database.user` and `database.name` if you set them: the app connects as
    `agt_knowledge_base` to `agt_knowledge_base`;
  - outside Docker, replace `DATABASE_URL` or `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/`DATABASE_SSL` with
    `database.*` in `config.yaml`, `DB_PASSWORD` with `AGT_KNOWLEDGE_BASE_DB_PASSWORD`, `CONFIG_FILE` with
    `AGT_KNOWLEDGE_BASE_CONFIG_FILE`, and remove `LOCAL_USER_PASSWORD` and `AUTH_MODE` ([#52](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/52)).
- **Member sign-in is limited to 10 attempts per 15 minutes** per client address by default (`rateLimits.login`;
  1.x allowed 5 per minute), and Admin sign-in and the Admin password change now use `rateLimits.login` too, each
  with its own counter. Backup restore uploads are limited to 120 per 15 minutes (`rateLimits.adminUploads`) ([#52](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/52)).
- **`session.ttlHours` now also sets the Admin session lifetime** unless the deprecated `adminSession.ttlHours` is set ([#52](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/52)).
- **Dashboard settings move to a `settings` table** (migration `015_settings_table`). Settings you changed in the
  dashboard are copied; settings still at their 1.x defaults stay at the defaults. Migration `016` then drops the old
  `application_settings` table ([#52](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/52)).
- **API clients: settings.** `GET /api/settings/public` returns the public settings grouped by `config.yaml` key
  (`site`, `articles`, `access`). `GET /api/admin/settings` adds `states` (one entry per setting with `key`, `value`,
  `source`, `locked`, `default` and `description`), and `PUT /api/admin/settings` takes `{ "values": { key: value | null } }`.
  `GET /api/settings`, the 1.x admin settings fields and the `version` check are deprecated; settings no longer
  carry a version, so a deprecated 1.x settings write no longer answers `409 conflict` ([#52](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/52)).

- **Everyone signs in again after upgrading.** Members now have cookie sessions instead of tokens in the browser's
  storage, and the Admin cookie is renamed to `agt_knowledge_base_session` with `Path=/`; old tokens and cookies are
  not accepted. Remove `LOCAL_AUTH_SECRET` from `.env`: it is no longer used, and the server logs a reminder while it
  is set. Migration `017_auth_sessions` rewrites stored password hashes into the new format; passwords stay the same
  and are rehashed with the stronger parameters at the next sign-in ([#53](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/53)).
- **The Admin username is now compared exactly** (after trimming surrounding spaces) instead of case-insensitively:
  sign in with the username as it was created (1.x stored it in lower case) ([#53](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/53)).
- **API clients: members sign in with `POST /api/member/login`** (`x-agt-request: 1` required), which sets the
  `agt_knowledge_base_member_session` cookie; `GET /api/member/session` and `POST /api/member/logout` complete the
  set. `POST /api/auth/login` and `GET /api/auth/session` and bearer tokens are gone without a deprecation period,
  as a security fix (VER-10). Every state-changing member request now needs `x-agt-request: 1` ([#53](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/53)).
- **API clients: setup and Admin errors follow AUTH-5.** `POST /api/setup` answers `503 setup_password_missing`
  instead of `403 setup_disabled` and `410 setup_complete` instead of `409 setup_already_completed`; a wrong current
  password on the Admin password change answers `401 invalid_credentials` instead of `403 invalid_current_password`
  (the 1.x `code` values are unchanged). `passwordConfirmation` is optional in the setup and password-change bodies ([#53](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/53)).
- **API clients: responses are never cached and carry no CORS headers.** Public reads no longer send
  `Cache-Control: public, max-age=30`, and `OPTIONS` requests answer `404`. `server.frontendOrigin` no longer enables
  CORS ([#53](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/53)).

- **The server connects to PostgreSQL as its own non-superuser role, `agt_knowledge_base`, and refuses to start as
  a superuser** (DATA-11). The `db` service creates the role and its databases on a new volume
  (`deploy/postgres-init/10-app-role.sh`), and loading the 1.x dump as that role makes it the owner of every table;
  a local installation creates them with `createuser` and `createdb` (README) ([#54](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/54)).
- **Migrations run when the server starts; the `migrate` service is gone.** Start with
  `docker compose up -d --build --remove-orphans`. The 1.x contract migrations that waited for `MIGRATION_TARGET_ID`
  (`007`, `014`, `016`) now run automatically; `MIGRATION_TARGET_ID` and `npm run db:migrate` no longer exist. A
  database with a migration the server does not know (a newer schema) stops it with a clear message ([#54](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/54)).
- **Backups are now `pg_dump` archives, and 2.0 cannot restore a 1.x backup.** A 1.x backup (`database.json`) is
  refused with `422 archive_rejected`: restore it with 1.x before upgrading, or keep a `pg_dump` of the 1.x database.
  Download a new backup after upgrading. The image contains the PostgreSQL 18 client tools; outside Docker,
  install `pg_dump` and `pg_restore` of your server's major version. The restore preview needs the
  `agt_knowledge_base_preview` database, which both installation methods create ([#55](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/55)).
- **Restores take the app offline briefly.** While a restore runs, every API request answers
  `503 maintenance`; while a backup runs, writes wait for it. If you run your own reverse proxy, allow several minutes
  for `POST /api/admin/restore` ([#55](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/55)).

- **Member pages moved to query-parameter addresses on `/`** (`/?article=<id>`, `/?view=login`, …). Old links and
  bookmarks keep working: the server redirects the 1.x paths to them. A reverse proxy needs no change ([#57](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/57)).
- **Browser preferences moved to one `localStorage` object, `agt_knowledge_base_settings`**, shared by the
  knowledge base and the admin dashboard. The settings dialog's text size replaces the 1.x "UI scale" and "font
  size" choices; a stored "large" or "extra large" font size becomes 1.25×, and the other 1.x `agt-*` preferences
  move over once ([#57](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/57), [#58](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/58))
- **The interface can be shown in ten languages**, chosen in the settings dialog; it stays in English until a reader
  picks another. Nothing needs to change on the server ([#58](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/58)).
- **Install and upgrade from release tags, not a branch.** Check out the latest `vX.Y.Z` tag after cloning, and
  upgrade with `git fetch --tags && git checkout vX.Y.Z` instead of `git pull`, after reading the upgrade notes and
  downloading a backup. To go back, check out the previous tag and restore that backup (README, *Upgrading* and
  *Rolling back*) (VER-13) ([#61](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/61)).

### Added
- `src/lib/client.ts`: every browser request goes through `apiRequest()`, same-origin with `cache: 'no-store'`, the
  CSRF header on writes and `x-agt-client: web` (so the audit log records `client: web`), and failures become
  `ApiError(status, message, code, fields)`. A `503 maintenance` shows a notice and is retried once after
  `Retry-After` (FE-2, FE-5, LOG-13, BAK-8) ([#57](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/57)).
- Forms check their input with the server's own parsers from `src/lib/validation.ts` and show each field error next
  to its field, linked with `aria-invalid` and `aria-describedby` (FE-6, A11Y-5) ([#57](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/57)).
- The AGT design system (§15): the logo, NMS Futura, the flag font and both font licence files copied unmodified from
  the spec's v6.0.0 `assets/` and checked by SHA-256, `src/agt-base.css` imported first, and a test that the app's
  CSS never redefines a base token or restyles a UI-9 class (UI-1..UI-16). The README has a **Credits** section (UI-15) ([#57](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/57)).
- One dialog behaviour for every dialog, `useDialog` (focus in, Tab trapped, Escape closes, focus returns, page
  scroll locked), with confirmation dialogs in place of the browser's `confirm()` (A11Y-2) ([#57](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/57)).
- A text size from 1× to 2× in the settings dialog; all text is sized in `rem` (A11Y-6) ([#57](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/57)).
- Browser tests in `tests/e2e/` (`npm run test:e2e`, Playwright): the rich editor and the PDF export under the
  production CSP (#48 §2), both entries loading without CSP violations or console errors, and every page fitting
  300 px (UI-12). New dev dependency `@playwright/test`, which STACK-1 names for TEST-6 ([#57](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/57)).
- The knowledge base and the admin dashboard in English, French, German, Spanish, Brazilian Portuguese, Italian,
  Thai, Simplified Chinese, Hindi and Japanese: every UI string comes from `src/translations.ts` (member UI) or
  `src/admin/i18n.ts` (admin UI), with the LOCALES list, flags and `<html lang>` (I18N-1..I18N-3). MDXEditor's
  toolbar and dialogs get their strings through its `translation` prop from the same tables (I18N-3) ([#58](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/58)).
- Language, time zone and text size in the settings dialog of both entries (the admin dashboard's behind a new gear
  button in its header), stored in `agt_knowledge_base_settings`; the time zone is the browser's own or a fixed UTC
  offset (I18N-4) ([#58](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/58)).
- Dates, times, numbers and byte sizes are formatted with `Intl` in the reader's language and time zone, with the
  offset shown beside each time (`src/lib/format.ts`, I18N-5) ([#58](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/58)).
- Errors are shown in the reader's language from their `error` code and `params`, and field errors from their field
  code and the translated field label (`errorText()`, `fieldErrorText()` in `src/lib/errors.ts`, I18N-6) ([#58](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/58)).
- API: `422 archive_rejected` carries `params.reason` (which check refused the archive), and restore previews and
  reports carry `warningCodes` beside `warnings`, so clients can translate them; the codes are listed in
  `docs/API.md` (I18N-6) ([#58](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/58)).
- Tests: every locale has every key with the English placeholders and no untranslated English sentence; every error
  code the server sends, every field code, archive rejection reason and restore warning has a string; no component
  has hard-coded text; switching the language changes the dialog and `<html lang>`; and the browser tests check
  300 px in German, Thai and Hindi (I18N-2, I18N-3, UI-12) ([#58](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/58)).
- The server log and the audit log (§13), in a `logs` schema of their own with `LOG_MIGRATIONS`
  (`server/migrations/logs/`), never part of a backup or touched by a restore (LOG-1, LOG-2, LOG-17). The server logs
  with pino to stdout (`server.logLevel`) and, from `info` up, to the server log: startup, configuration warnings,
  migrations, backups, retention runs, unexpected errors with their stack, and shutdown (LOG-5..LOG-9). New runtime
  dependency: `pino`, which STACK-1 names as Fastify's logger and LOG-5 requires as a direct dependency ([#56](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/56)).
- One `onResponse` hook audits every write, backup downloads and log exports, every denied admin request and every
  rate-limited request, with the actor (Admin, member or anonymous), a pseudonymous HMAC of the client address, the
  action (`operationId`), target, outcome and a summary that never holds values or bodies; settings changes record old
  and new values. Identical failures from one address within 60 seconds are counted in one entry (LOG-10..LOG-14).
  Members are recorded as `actorType: member` (the AUTH-1 deviation) ([#56](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/56)).
- Retention at startup and every hour, with the dashboard settings `logs.serverRetentionDays` (30),
  `logs.serverMaxEntries` (100000), `logs.auditRetentionDays` (365, at least 30) and `logs.auditMaxEntries` (1000000)
  (LOG-15, LOG-16) ([#56](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/56)).
- The admin panel's **Server log** and **Audit log** tabs, with filters, paging, entry details, JSON Lines and CSV
  exports (formula-neutralized), **Clear log** for the server log only, and a badge and notice for unseen warnings
  and errors, backed by `GET /api/admin/logs/server`, `…/server/export`, `…/server/summary`,
  `POST …/server/seen`, `DELETE /api/admin/logs/server`, `GET /api/admin/logs/audit` and `…/audit/export`
  (LOG-18..LOG-22). The README documents what the logs hold (LOG-23) ([#56](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/56)).
- Backups (§12): `GET /api/admin/backup` downloads `agt-knowledge-base-backup-<timestamp>.zip` with a `pg_dump`
  custom-format `database.dump` of the `public` schema (without session rows), `config.yaml`, and the BAK-2
  `manifest.json` (format version 1, schema version, each file's size and SHA-256) (BAK-1, BAK-2, BAK-6, BAK-7) ([#55](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/55)).
- `POST /api/admin/restore` (multipart `backup` file and `action=preview|restore`). The preview filters the dump's
  table of contents through an allowlist and restores it into the preview database (`database.previewName`) to check
  it; the restore checks the upload again, writes a pre-restore backup and its restore list, replaces the database
  with `pg_restore` in one transaction, migrates and checks it, and rolls back to the pre-restore backup if anything
  fails (BAK-3, BAK-4, BAK-10). Server-side ZIP handling lives in `server/zip.ts` (SEC-10). New runtime
  dependency: `@fastify/multipart`, the plugin STACK-1 names for uploads ([#55](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/55)).
- The BAK-12 shared operation lock: a `control` schema with its own migrations (`server/migrations/control/`), a
  control connection per process, the operation, activity and write advisory locks, admission of every API request
  under the activity lease, and following of the shared state. Every route declares `writesData`, and data writes
  run in `withDataWrite()`. During a restore the API answers `503 maintenance` with `Retry-After: 10` and
  `GET /api/health` reports `maintenance` (BAK-8, BAK-9, BAK-12) ([#55](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/55)).
- Failed-restore recovery (BAK-11): a restore whose rollback fails, or whose process dies, leaves every process in
  maintenance, writes `restore-failed.json` to `storage.dataDir`, and lets only the restoring Admin's session run a
  recovery restore; the server refuses to start until the operator has cleared the failed state (README,
  "Recovering from a failed restore") ([#55](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/55)).

- `GET /api/openapi.json`: the OpenAPI 3.1 document of every route, generated from the route schemas, with the app
  version ([#51](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/51)).
- `GET /api/health` reports whether the API and its database answer ([#51](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/51)).
- The API paths of the AGT web app specification: `GET /api/setup/status`, `POST /api/setup`,
  `POST /api/admin/login`, `POST /api/admin/logout`, `GET /api/admin/session` and `POST /api/admin/password`
  ([#51](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/51)).
- The admin dashboard header shows the app version, which `GET /api/admin/session` now returns ([#51](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/51)).
- `GET /api/settings/public` (CFG-10), and the dashboard settings `site.supportUrl` (the support link, shown in the
  Settings tab) and `server.logLevel`, `storage.dataDir`, `database.*` and `rateLimits.adminUploads` in `config.yaml`
  (CFG-5) ([#52](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/52)).
- `PUT /api/admin/settings` refuses a key that is not a dashboard setting with `400 unknown_setting`, and an invalid
  value with `400 invalid_setting`, naming the key in `params.key` (CFG-8) ([#52](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/52)).
- Article lists show a **Load more** button instead of page numbers, so pages never repeat or skip articles while
  others are edited ([#51](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/51)).

- Member cookie sessions: `POST /api/member/login`, `GET /api/member/session` and `POST /api/member/logout`, with a
  `member_sessions` table; a password reset, deactivation, role change or deletion by the Admin ends all of that
  member's sessions (AUTH-1 deviation, AUTH-4, AUTH-8) ([#53](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/53)).
- `GET /api/setup/status` returns `adminExists`, and the Admin session `setupPasswordStillSet` (AUTH-5, AUTH-6) ([#53](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/53)).
- The server refuses to start while no Admin exists and `AGT_KNOWLEDGE_BASE_SETUP_PASSWORD` is longer than 1024
  characters, logs "Admin account created. Remove AGT_KNOWLEDGE_BASE_SETUP_PASSWORD from .env and restart." after
  setup, and warns at every start while an Admin exists and the variable is still set (AUTH-5, AUTH-6) ([#53](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/53)).
- A one-time warning in the server log when a sign-in or setup request arrives over plain HTTP from another machine,
  and `deploy/Caddyfile.example` for the TLS proxy (SEC-4, DEP-10) ([#53](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/53)).

- Migrations are numbered files `server/migrations/NNNN_<name>.sql`, applied at startup under a PostgreSQL advisory
  lock and recorded in `schema_migrations (version, name, applied_at)`, which the server converts from the 1.x table
  (DATA-3, DATA-4, DATA-11) ([#54](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/54)).
- `deploy/postgres-init/10-app-role.sh`, which creates the database role and the restore preview database
  `agt_knowledge_base_preview` (DEP-3) ([#54](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/54)).
- One Docker image, `node:26-bookworm-slim` in two stages with the PGDG `postgresql-client-18`, running as `node`,
  with a healthcheck on `127.0.0.1:8081/api/health` and `/app/data` as its only volume (DEP-1, BAK-6) ([#59](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/59)).
- The Compose stack `knowledge-base` and `db` (`postgres:18-bookworm`): the app published on `127.0.0.1:8081` only,
  with `read_only`, a `tmpfs` at `/tmp`, `no-new-privileges` and a healthcheck; the database port is not published,
  and only the `db` container reads the superuser password from `.env.db` (DEP-2, DEP-3, SEC-15, DATA-10) ([#59](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/59)).
- Local installation as a systemd service: `deploy/agt-knowledge-base.service` with the DEP-7 sandboxing, data in
  `/var/lib/agt-knowledge-base`, configuration in `/etc/agt-knowledge-base` (DEP-6..DEP-9) ([#59](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/59)).
- CI starts the Compose stack from the README's steps and checks that it is healthy, answers `/api/health` and
  `/api/setup/status`, and publishes the app on `127.0.0.1` and the database not at all (TEST-8) ([#59](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/59)).
- Server tests against a real PostgreSQL (TEST-3, TEST-4): `createTestServer()` starts the app on a fresh database
  created through `AGT_KNOWLEDGE_BASE_TEST_DATABASE_URL`, and the tests cover startup and migrations (two processes
  at once, a newer control schema), a backup round trip (only `public` dumped, logs kept, sessions emptied), the
  BAK-3 allowlist on real dumps with a function, trigger, view, extra schema, unknown table or ACL entry, and two
  processes on one database: writes waiting for a backup, maintenance during a restore, admission against the shared
  state, aborts when the control connection drops, owner failure in a backup and in a restore, and a process started
  during a backup; restore previews (a newer schema, a missing table, a bad Admin hash, an extension, a second preview
  at the same time, a process started during a preview), the BAK-10 rollback list, the BAK-11 recovery restore from
  another process, and the drain (a write in progress included in a backup, a write held past the lock timeout, and a
  restore waiting for a held read, a job and a download) ([#60](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/60)).
- Browser tests against the real server (TEST-6): Playwright starts `node dist-server/index.mjs` on a fresh database
  from first run, creates the Admin and the members through the UI, and covers the public pages, sign-in, articles,
  downloads and the PDF export, the editor and the revision history, tags, the settings dialog, and every admin tab;
  axe finds no WCAG 2.2 AA violation on any page, no page scrolls sideways at 300, 520, 640, 760 or 1180 px, at
  300 px with the 2× text size or in German, Thai and Hindi, every dialog keeps the keyboard, and status messages are
  announced (A11Y-1..A11Y-6, UI-12). New dev dependency `@axe-core/playwright`, which STACK-1 names for TEST-6. CI runs
  them on every pull request ([#60](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/60)).
- `docs/RELEASING.md`: the release PR and its acceptance checks (TEST-7 checklist, TEST-8 installation runs, TEST-9
  upgrade and rollback) (VER-12) ([#60](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/60)).
- A real-PostgreSQL test of the README's *Rolling back* steps: the backup taken before an upgrade replaces a newer
  schema, and the previous version starts on it (VER-13) ([#61](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/61)).

### Changed

- Follows the AGT Web Application Specification v6.0.1 instead of v6.0.0 (SPEC-3): the pinned copy in
  `docs/agt-webapp-spec.md` is the `v6.0.1` tag, whose app registry lists `knowledge-base` (port 8081, PostgreSQL), so
  the NAME-1 deviation is gone. The assets are unchanged ([#62](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/62)).
- The README follows the DOC-1 order: the AI disclosure and the self-hosting guarantees, then Installation (Docker
  Compose and local, both from a release tag, TLS, Upgrading, Rolling back), First run, a Configuration reference with
  separate tables of config-file-only and dashboard-editable keys, the Admin dashboard, the app's own sections, Backup
  & restore (restoring `config.yaml` by hand), Logs, Content safety, Development (commands and layout tables) and
  Troubleshooting (DOC-1, VER-13) ([#61](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/61)).
- The member UI has no router: pages are query parameters on `/` and links are rewritten with
  `history.replaceState` when normalized (STACK-2, FE-4); the server serves `index.html` only at `/` (SRV-9) ([#57](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/57)).
- Icons are inline SVG components in `src/components/Icons.tsx` (FE-7) ([#57](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/57)).
- UI-7 public chrome: the brand lockup with the AGT logo, round icon buttons with labels, and the support link from
  `site.supportUrl`. UI-8 admin shell: header with **View site** and **Sign out**, and the tabs as a `tablist` in the
  standard order (Users, Data, Settings, Server log, Audit log, Backup & restore, Account, then API) ([#57](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/57)).
- MDXEditor gets its strings through its `translation` prop (English until the Phase 9 string tables), its colours
  from the AGT tokens through its own CSS variables, and focus returns to its block-type select after Escape ([#57](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/57)).
- Zod runs jitless, so validating in the browser never trips the CSP's `script-src` with an `eval` probe ([#57](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/57)).
- Status messages are announced through live regions (`role="status"`); errors use `role="alert"` (A11Y-4) ([#57](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/57)).
- The admin panel's backup tab explains a refused archive in the reader's language and keeps the server's English
  text under **Technical details** ([#58](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/58)).
- Long words wrap (with hyphenation where the language allows) instead of widening the sign-in pages past 300 px
  (UI-12) ([#58](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/58)).
- Request IDs are random UUIDs, so they link audit and server log entries across restarts ([#56](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/56)).

- The API now runs on Fastify 5 instead of a hand-written Node.js HTTP server, with the same routes, authentication,
  CSRF checks, rate limits, body limits and error bodies. Unexpected errors are logged as JSON lines on standard
  output and always answer `500 INTERNAL_ERROR` with the same message. The Docker images now use Node.js 26
  ([#50](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/50)).
- Building or developing from source needs Node.js 26 and npm 11.20 or newer within npm 11; `npm ci` stops with an
  engine error on older versions. The API is started for development with `npm run dev:server` instead of
  `npm run api:dev`, and `npm run check` runs every check
  ([#50](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/50)).

- The admin panel's **API** tab renders the generated OpenAPI document instead of hand-written files ([#51](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/51)).
- The API server serves the member UI and the admin panel (SRV-9) ([#51](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/51)).
- `config.yaml` is validated with a TypeBox schema; an error names the key and the problem, for example
  `Invalid config.yaml: server.prot: Unexpected property` (CFG-3). A missing file now logs a warning ([#52](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/52)).
- Only the CFG-2 environment variables are read, all with the `AGT_KNOWLEDGE_BASE_` prefix: `_SETUP_PASSWORD`,
  `_DB_PASSWORD`, `_CONFIG_FILE` (default `./config.yaml`), `_DATABASE_HOST`, `_SERVER_HOST` and `_STATIC_DIR`, plus
  `LOCAL_AUTH_SECRET` until member sessions change. The database
  name, user, port and TLS setting come from `database.*` in `config.yaml` ([#52](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/52)).
- `server.trustProxy` also accepts a proxy IP or CIDR, or a list of them ([#52](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/52)).
- Settings precedence (config file, then dashboard, then default) is computed in one place, `settingStates()`; a
  backup restore drops the restored dashboard settings whose keys `config.yaml` sets and lists them in its report ([#52](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/52)).
- The server sends CORS headers only when the deprecated `server.frontendOrigin` is set; the site itself is
  same-origin ([#52](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/52)).

- Passwords are hashed with scrypt `N = 2^15, r = 8, p = 1` and NFKC-normalized input, stored as
  `scrypt$N$r$p$<salt>$<hash>`; a stored hash in any other format is rejected without calling scrypt, answers like a
  wrong password and is logged as an error (AUTH-2) ([#53](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/53)).
- The Admin username is stored as entered after trimming, 1–64 characters (AUTH-3) ([#53](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/53)).
- Sessions: the Admin cookie is `agt_knowledge_base_session` with `Path=/`, stored in `sessions` (renamed from
  `admin_sessions`); `session.secureCookie: auto` marks cookies `Secure` when a trusted proxy reports HTTPS (AUTH-8) ([#53](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/53)).
- One `onRequest` hook in `server/adminRoutes.ts` checks the CSRF header and the session cookies (AUTH-9, SEC-5) ([#53](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/53)).
- Every response carries the spec's Content-Security-Policy, `X-Frame-Options: DENY`, `X-Content-Type-Options`,
  `Referrer-Policy` and `Cross-Origin-Opener-Policy`; API and HTML responses are never cached (SEC-1..SEC-3) ([#53](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/53)).
- Rate limits use `@fastify/rate-limit` with per-route limits; a deprecated path shares its replacement's limit
  (SEC-7). New runtime dependency: `@fastify/rate-limit`, the plugin the spec requires ([#53](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/53)).
- Markdown is rendered by one component, `src/components/Markdown.tsx`: raw HTML appears as text, only `http:`,
  `https:` and same-site URLs are kept, external links open in a new tab with `rel="noopener noreferrer"`, and
  external images load lazily without a referrer and show a fallback when they fail (SEC-12, SEC-13) ([#53](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/53)).

- Migration `0018_spec_storage`: the server merges orphaned tag IDs itself, so the last database function and the
  `pgcrypto` extension are gone; new rows get `crypto.randomUUID()` IDs from the server instead of column defaults,
  and incoming IDs must be UUIDv4 (DATA-6, DATA-11); `varchar(n)` columns are `text` with the same length checks;
  `articles.modified_at` is renamed `updated_at`, and `app_users` and both session tables gain `updated_at` (DATA-8) ([#54](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/54)).
- All SQL lives in `server/repository/` (SRV-4), except the backup code that Phase 6 replaces ([#54](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/54)).
  The backup and operation-lock SQL is there too now ([#55](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/55)).
- The `backup.*` limits follow CFG-5: `maxZipBytes` 1024 to 2 GiB (default 200 MiB), `maxUncompressedBytes` 1024 to
  8 GiB (default 1 GiB), `maxEntries` 1 to 100000 (default 10000). Values set before stay valid ([#55](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/55)).
- Restore previews and reports have `formatVersion`, `schemaVersion` (`backup`, `current`) and `warnings`; a
  report's `preRestoreBackup` is `null` after a recovery restore. Archive problems answer `422 archive_rejected`
  (1.x `code` `INVALID_BACKUP`) instead of `400 invalid_backup` (API-6) ([#55](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/55)).
- The server refuses to start when `database.previewName` names the app's own database ([#55](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/55)).
- The member routes moved from `server/handler.ts` to `server/memberRoutes.ts`, beside `adminRoutes.ts`, and the
  public reads into `app.ts` (REPO-1) ([#59](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/59)).
- `.env.example` documents the production `.env` (DEP-4), and `deploy/Caddyfile.example` proxies to `127.0.0.1:8081`
  and explains `server.trustProxy` for both installation methods (DEP-10) ([#59](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/59)).
- When a process loses its control connection, the requests it is serving answer `503 maintenance` at once: a data
  write rolls back instead of committing, and a download stops. A request's share of the activity lease lasts until
  its handler has finished, even when the client disconnects first, and the log retention job is admitted under the
  lease like a request (BAK-8, BAK-12) ([#60](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/60)).
- Accessibility fixes the axe checks found: the article cards' tag lists are labelled groups, the site link's and the
  sort button's accessible names contain their visible text (WCAG 2.5.3), and the admin settings' help text has
  enough contrast (A11Y-1). Focus returns to the editor's Save button when its review dialog closes (A11Y-2) ([#60](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/60)).
- Layout fixes: the admin tabs, the log tables and the article, history, editor and Tags pages fit 300 px, also with
  the 2× text size; long words wrap instead of widening the page (UI-12, A11Y-6) ([#60](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/60)).

### Deprecated

- The 1.x member page paths `/login`, `/tags`, `/articles/new`, `/articles/<id>`, `/articles/<id>/history` and
  `/articles/<id>/edit`, which now redirect (`301`) to their query-parameter addresses ([#57](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/57)).

These keep working unchanged and are removed in 3.0.0 ([#51](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/51)):

- `POST /api/admin/backup/restore?action=preview|restore` with the raw ZIP body (use the multipart
  `POST /api/admin/restore`), and the `migrations` field of restore previews and reports (use `schemaVersion`) ([#55](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/55)).

- `GET /api/admin/setup/status`, `POST /api/admin/setup`, `POST /api/admin/auth/login`, `POST /api/admin/auth/logout`,
  `GET /api/admin/auth/session` and `PUT /api/admin/auth/password`: use `GET /api/setup/status`, `POST /api/setup`,
  `POST /api/admin/login`, `POST /api/admin/logout`, `GET /api/admin/session` and `POST /api/admin/password`.
- The `code` and `issues` properties of error bodies: use `error` and `fields`.
- The `page` and `pageSize` parameters of the article lists, and the `page`, `pageSize` and `totalPages` fields they
  return: use `limit`, `cursor` and `nextCursor`.

These keep working and are removed in 3.0.0; each one used logs a warning at startup ([#52](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/52)):

- The `config.yaml` keys `site.applicationName`, `site.applicationSubtitle`, `backup.maxBytes`,
  `adminSession.secureCookie` (renamed to `site.title`, `site.subtitle`, `backup.maxZipBytes`,
  `session.secureCookie`), `adminSession.ttlHours`, `rateLimits.adminLogin`, `rateLimits.adminPassword` and
  `server.frontendOrigin`.
- The environment variables `AGT_SETUP_PASSWORD`, `CONFIG_FILE`, `DB_PASSWORD` (renamed with
  the `AGT_KNOWLEDGE_BASE_` prefix), `DATABASE_URL`, `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DATABASE_SSL`
  (replaced by `database.*` in `config.yaml`) and `AUTH_MODE`.

These keep working unchanged and are removed in 3.0.0 ([#52](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/52)):

- `GET /api/settings`: use `GET /api/settings/public`.
- The `version` and `settings` fields of `GET`/`PUT /api/admin/settings` responses, and the 1.x fields of the
  `PUT` body: use `states` and `values`.


These keep working and are removed in 3.0.0:

- The `required` field of `GET /api/setup/status` (use `adminExists`) and the `setupPasswordSet` field of the Admin
  session (use `setupPasswordStillSet`) ([#53](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/53)).
- `server.frontendOrigin` now only marks session cookies `Secure` under `session.secureCookie: auto` when it is an
  `https://` origin ([#53](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/53)).
- A number of proxy hops as `server.trustProxy` (the 1.x `trustProxy: 1` for the bundled Nginx): set the proxy's
  address instead (CFG-5) ([#59](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/59)).

### Removed

- The runtime dependencies `react-router-dom` and `lucide-react` (STACK-2, FE-7), the `VITE_API_URL` build variable
  (the API is always same-origin, FE-2), and `public/assets/agt-icon.png` (replaced by `/AgtOfficialLogo.webp`) ([#57](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/57)).
- The 1.x backup format (`database.json` with a table dump, `formatVersion: 2`) and the staging-schema restore
  (agreed in #48) ([#55](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/55)).
- The error codes `invalid_backup` and `pre_restore_backup_failed`, replaced by `422 archive_rejected` and
  `500 internal` ([#55](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/55)).

- The public **API reference** page at `/api-docs` and its footer link; the API reference is now shown only to the
  Admin, in the admin panel (API-14) ([#51](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/51)).
- The hand-written `docs/openapi.yaml` and `docs/openapi-admin.yaml`, replaced by `GET /api/openapi.json` ([#51](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/51)).

- Member bearer tokens: `POST /api/auth/login`, `GET /api/auth/session` and `LOCAL_AUTH_SECRET`, replaced by
  member cookie sessions (FE-3; VER-10's security exception) ([#53](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/53)).
- CORS headers and the `OPTIONS` answer for `server.frontendOrigin` (SEC-6) ([#53](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/53)).
- The `rehype-sanitize` dependency: Markdown never creates elements from raw HTML (SEC-12) ([#53](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/53)).
- The error codes `setup_disabled`, `setup_already_completed` and `invalid_current_password`, which no release had
  sent (the 1.x `code` values stay) ([#53](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/53)).

- The `migrate` Compose service, `scripts/migrate.ts`, `npm run db:migrate` and `MIGRATION_TARGET_ID` ([#54](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/54)).

- The `web` image and `nginx.conf`, the `api` and `postgres` Compose services, the `agt-postgres` and `agt-backups`
  volumes, `docker.env.example`, and the Compose variables `POSTGRES_USER`, `POSTGRES_DB`, `POSTGRES_BIND_ADDRESS`,
  `POSTGRES_PORT`, `APP_BIND_ADDRESS` and `APP_PORT`; the database port is no longer published (DEP-2, DEP-3) ([#59](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/59)).
- `deploy/upgrade-database-role.sql`: the 1.x data is loaded into the new database as the app role instead ([#59](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/59)).
- The member-recovery command `scripts/manage-local-user.ts`, `npm run build:scripts`, and its variables
  `AGT_KNOWLEDGE_BASE_LOCAL_USER_PASSWORD` and `LOCAL_USER_PASSWORD`: the Admin creates, resets and reactivates
  member accounts in the admin panel (REPO-1) ([#59](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/59)).
- The Vitest + jsdom component tests and the dev dependencies `vitest`, `jsdom` and `@testing-library/*`, replaced by
  the browser tests; UI logic that needs no DOM moved to `src/lib/markdown.ts` and `src/lib/tags.ts`, tested with
  `node:test` (STACK-1, TEST-1, TEST-3) ([#60](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/60)).

### Security

- A restore can only run the parts of a dump that the BAK-3 allowlist keeps (tables, data, sequences, defaults,
  constraints and indexes of the app's tables); functions, triggers, views, extensions, permissions and other
  schemas reject the archive. The dump is restored into a separate preview database first, and the backup tools get
  the database password only through `PGPASSWORD` (BAK-3, BAK-6) ([#55](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/55)).

- Member sessions are `HttpOnly` cookies that page scripts cannot read, and every member write needs the CSRF
  header (FE-3, SEC-5) ([#53](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/53)).
- A strict Content-Security-Policy, no CORS, and loopback-only defaults for the server and the Compose web port
  (SEC-1, SEC-4, SEC-6) ([#53](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/53)).
- Updated `zod` and the `dompurify` dependency of `html2pdf.js` to versions without known vulnerabilities
  ([#50](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/50)).

## [1.0.0] - 2026-11-14

The first release recorded in this file: the self-hosted application before the work to comply with the AGT Web
Application Specification v6.0.0 ([#48](https://github.com/agtdarkshadow04/agt_knowledge_base/issues/48)).

### Added

- Knowledge base with server-paginated browsing, search, tags, sorting, safe Markdown rendering, linked tables of
  contents, revision history with comparison of the five most recent revisions, and PDF export.
- Member accounts with the Editor and Moderator roles. Moderators control protection, pinning, verification,
  restoration, deletion, tags and the restricted visibility levels.
- Legacy (`Public`, `Internal`, `Admin`) and AGT-standard (`0`–`5`) article visibility levels.
- Optimistic concurrency: updates, restores and deletes that carry an outdated article version are refused with
  `409` instead of overwriting another member's edit.
- Self-hosting with Docker Compose (Nginx, Node.js API and PostgreSQL), with no cloud account or external service
  ([#32](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/32)).
- A separate installation Admin account at `/admin`, created on first run with `AGT_SETUP_PASSWORD`, that manages
  member accounts, dashboard settings, statistics and backups; `config.yaml` for non-secret settings, which always
  wins over the dashboard; backup download, preview and restore
  ([#45](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/45)).
- API documentation: an OpenAPI description of the public, member and admin routes, an API guide, and in-app API
  pages ([#47](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/47)).
