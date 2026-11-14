# Changelog

All notable changes to AGT Knowledge Base are documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html), as described in §21 of the
[AGT Web Application Specification](docs/agt-webapp-spec.md).

## [2.0.0] - Unreleased

### Upgrade notes

- **Building from source needs Node.js 26 and npm 11.20 or newer within npm 11.** `npm ci` now stops with an engine
  error on older versions. Docker Compose installations need no action beyond rebuilding the images
  (`docker compose up -d --build`), which now use Node.js 26
  ([#50](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/50)).
- **Development:** start the API with `npm run dev:server` instead of `npm run api:dev`, and run every check with
  `npm run check` (lint is now `tsc -b`; `npm run typecheck` is gone)
  ([#50](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/50)).
- **The API server now serves the web UI too, and Nginx only forwards.** Docker Compose installations rebuild both
  images (`docker compose up -d --build`); the `web` image no longer contains the UI. If you run your own Nginx or
  proxy in front of the `api` container instead of the bundled one, forward every path (not only `/api/`) to it
  without rewriting the path: the API now expects the `/api` prefix ([#51](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/51)).
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
  unless `server.host` or `AGT_KNOWLEDGE_BASE_SERVER_HOST` says otherwise; the Docker image sets `0.0.0.0` and the
  bundled Nginx forwards to `api:8081`. If your `config.yaml` sets `server.port: 3001`, remove it; if you run your own
  proxy in front of the `api` container, point it at port 8081. The public port of the Compose stack is unchanged ([#52](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/52)).
- **Configuration keys and environment variables have their spec names.** The 1.x names still work until 3.0.0 and
  each one used logs a deprecation warning at startup, so nothing has to change now. To silence the warnings:
  - in `config.yaml`, rename `site.applicationName` → `site.title`, `site.applicationSubtitle` → `site.subtitle`,
    `backup.maxBytes` → `backup.maxZipBytes`, `adminSession.secureCookie` → `session.secureCookie`; remove
    `adminSession.ttlHours`, `rateLimits.adminLogin` and `rateLimits.adminPassword` unless you need values other than
    `session.ttlHours` and `rateLimits.login`; remove `server.frontendOrigin` behind a TLS proxy that `trustProxy`
    trusts (the Admin cookie is then still `Secure`);
  - in `.env`, rename `AGT_SETUP_PASSWORD` → `AGT_KNOWLEDGE_BASE_SETUP_PASSWORD`;
  - with Docker Compose, set `database.user` in `config.yaml` to your `POSTGRES_USER` (`postgres` unless you set it;
    `agt` if you copied `docker.env.example`), and `database.name` if you changed `POSTGRES_DB`;
  - outside Docker, replace `DATABASE_URL` or `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/`DATABASE_SSL` with
    `database.*` in `config.yaml`, `DB_PASSWORD` with `AGT_KNOWLEDGE_BASE_DB_PASSWORD`, `CONFIG_FILE` with
    `AGT_KNOWLEDGE_BASE_CONFIG_FILE`, `LOCAL_USER_PASSWORD` with `AGT_KNOWLEDGE_BASE_LOCAL_USER_PASSWORD`, and remove
    `AUTH_MODE` ([#52](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/52)).
- **Member sign-in is limited to 10 attempts per 15 minutes** per client address by default (`rateLimits.login`;
  1.x allowed 5 per minute), and Admin sign-in and the Admin password change now use `rateLimits.login` too, each
  with its own counter. Backup restore uploads are limited to 120 per 15 minutes (`rateLimits.adminUploads`) ([#52](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/52)).
- **`session.ttlHours` now also sets the Admin session lifetime** unless the deprecated `adminSession.ttlHours` is set ([#52](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/52)).
- **Dashboard settings move to a `settings` table** (migration `015_settings_table`). Settings you changed in the
  dashboard are copied; settings still at their 1.x defaults stay at the defaults. Once 2.0.0 runs, drop the old
  table with `docker compose run --rm -e MIGRATION_TARGET_ID=016_drop_application_settings migrate` ([#52](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/52)).
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
- **The Compose stack now publishes its web port on `127.0.0.1` only** (`APP_BIND_ADDRESS` defaults to `127.0.0.1`
  instead of `0.0.0.0`), because the stack speaks plain HTTP (SEC-4). Behind a TLS proxy on the same host nothing
  changes. To reach the site from other machines, put a TLS proxy in front (README, HTTPS, and
  `deploy/Caddyfile.example`); only if that proxy runs elsewhere, set `APP_BIND_ADDRESS` in `.env` ([#53](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/53)).
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

### Added

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

### Changed

- The API now runs on Fastify 5 instead of a hand-written Node.js HTTP server, with the same routes, authentication,
  CSRF checks, rate limits, body limits and error bodies. Unexpected errors are logged as JSON lines on standard
  output and always answer `500 INTERNAL_ERROR` with the same message. The Docker images now use Node.js 26
  ([#50](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/50)).
- Building or developing from source needs Node.js 26 and npm 11.20 or newer within npm 11; `npm ci` stops with an
  engine error on older versions. The API is started for development with `npm run dev:server` instead of
  `npm run api:dev`, and `npm run check` runs every check
  ([#50](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/50)).

- The admin panel's **API** tab renders the generated OpenAPI document instead of hand-written files ([#51](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/51)).
- The API server serves the member UI and the admin panel; Nginx only forwards to it ([#51](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/51)).
- `config.yaml` is validated with a TypeBox schema; an error names the key and the problem, for example
  `Invalid config.yaml: server.prot: Unexpected property` (CFG-3). A missing file now logs a warning ([#52](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/52)).
- Only the CFG-2 environment variables are read, all with the `AGT_KNOWLEDGE_BASE_` prefix: `_SETUP_PASSWORD`,
  `_DB_PASSWORD`, `_CONFIG_FILE` (default `./config.yaml`), `_DATABASE_HOST`, `_SERVER_HOST` and `_STATIC_DIR`, plus
  `LOCAL_AUTH_SECRET` until member sessions change and the recovery command's `_LOCAL_USER_PASSWORD`. The database
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
  `admin_sessions`); `session.secureCookie: auto` marks cookies `Secure` when a trusted proxy reports HTTPS (AUTH-8).
  The bundled Nginx now passes on the `X-Forwarded-Proto` a TLS proxy in front of it sends ([#53](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/53)).
- One `onRequest` hook in `server/adminRoutes.ts` checks the CSRF header and the session cookies (AUTH-9, SEC-5) ([#53](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/53)).
- Every response carries the spec's Content-Security-Policy, `X-Frame-Options: DENY`, `X-Content-Type-Options`,
  `Referrer-Policy` and `Cross-Origin-Opener-Policy`; API and HTML responses are never cached (SEC-1..SEC-3) ([#53](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/53)).
- Rate limits use `@fastify/rate-limit` with per-route limits; a deprecated path shares its replacement's limit
  (SEC-7). New runtime dependency: `@fastify/rate-limit`, the plugin the spec requires ([#53](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/53)).
- Markdown is rendered by one component, `src/components/Markdown.tsx`: raw HTML appears as text, only `http:`,
  `https:` and same-site URLs are kept, external links open in a new tab with `rel="noopener noreferrer"`, and
  external images load lazily without a referrer and show a fallback when they fail (SEC-12, SEC-13) ([#53](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/53)).

### Deprecated

These keep working unchanged and are removed in 3.0.0 ([#51](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/51)):

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
- The environment variables `AGT_SETUP_PASSWORD`, `CONFIG_FILE`, `DB_PASSWORD`, `LOCAL_USER_PASSWORD` (renamed with
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

### Removed

- The public **API reference** page at `/api-docs` and its footer link; the API reference is now shown only to the
  Admin, in the admin panel (API-14) ([#51](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/51)).
- The hand-written `docs/openapi.yaml` and `docs/openapi-admin.yaml`, replaced by `GET /api/openapi.json` ([#51](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/51)).

- Member bearer tokens: `POST /api/auth/login`, `GET /api/auth/session` and `LOCAL_AUTH_SECRET`, replaced by
  member cookie sessions (FE-3; VER-10's security exception) ([#53](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/53)).
- CORS headers and the `OPTIONS` answer for `server.frontendOrigin` (SEC-6) ([#53](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/53)).
- The `rehype-sanitize` dependency: Markdown never creates elements from raw HTML (SEC-12) ([#53](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/53)).
- The error codes `setup_disabled`, `setup_already_completed` and `invalid_current_password`, which no release had
  sent (the 1.x `code` values stay) ([#53](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/53)).

### Security

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
