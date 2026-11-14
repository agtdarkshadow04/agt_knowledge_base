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
  without rewriting the path: the API now expects the `/api` prefix ([#PR_PHASE2](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/PR_PHASE2)).
- **API clients: error bodies changed.** Every error now has a snake_case `error` code (for example `not_found`,
  `validation_failed`, `conflict`), English `message`, optional `params`, and `fields` for field errors
  (`{ field, code, message, params? }`). The 1.x `code` and `issues` properties are still sent but deprecated.
  Unexpected errors answer `An unexpected server error occurred.` ([#PR_PHASE2](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/PR_PHASE2)).
- **API clients: a malformed ID in a path now answers `404 not_found`** instead of `400` with `INVALID_ID`,
  `INVALID_TAG_ID` or `INVALID_USER_ID` ([#PR_PHASE2](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/PR_PHASE2)).
- **API clients: request bodies must be JSON with `content-type: application/json`** and match the route's schema;
  a body with properties the route does not declare, or values of the wrong type, answers `400 validation_failed`
  with `fields` (unknown properties were already refused) ([#PR_PHASE2](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/PR_PHASE2)).
- **API clients: article lists are paged with cursors.** Without `page`, `GET /api/articles`,
  `GET /api/member/articles` and `GET /api/admin/articles` return `{ items, nextCursor, total }` with up to `limit`
  (default 50) articles; pass `nextCursor` as `cursor` for the next page. Clients that send `page` still get the 1.x
  response with `page`, `pageSize` and `totalPages`, until 3.0.0 ([#PR_PHASE2](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/PR_PHASE2)).

### Added

- `GET /api/openapi.json`: the OpenAPI 3.1 document of every route, generated from the route schemas, with the app
  version ([#PR_PHASE2](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/PR_PHASE2)).
- `GET /api/health` reports whether the API and its database answer ([#PR_PHASE2](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/PR_PHASE2)).
- The API paths of the AGT web app specification: `GET /api/setup/status`, `POST /api/setup`,
  `POST /api/admin/login`, `POST /api/admin/logout`, `GET /api/admin/session` and `POST /api/admin/password`
  ([#PR_PHASE2](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/PR_PHASE2)).
- The admin dashboard header shows the app version, which `GET /api/admin/session` now returns ([#PR_PHASE2](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/PR_PHASE2)).
- Article lists show a **Load more** button instead of page numbers, so pages never repeat or skip articles while
  others are edited ([#PR_PHASE2](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/PR_PHASE2)).

### Changed

- The API now runs on Fastify 5 instead of a hand-written Node.js HTTP server, with the same routes, authentication,
  CSRF checks, rate limits, body limits and error bodies. Unexpected errors are logged as JSON lines on standard
  output and always answer `500 INTERNAL_ERROR` with the same message. The Docker images now use Node.js 26
  ([#50](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/50)).
- Building or developing from source needs Node.js 26 and npm 11.20 or newer within npm 11; `npm ci` stops with an
  engine error on older versions. The API is started for development with `npm run dev:server` instead of
  `npm run api:dev`, and `npm run check` runs every check
  ([#50](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/50)).

- The admin panel's **API** tab renders the generated OpenAPI document instead of hand-written files ([#PR_PHASE2](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/PR_PHASE2)).
- The API server serves the member UI and the admin panel; Nginx only forwards to it ([#PR_PHASE2](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/PR_PHASE2)).

### Deprecated

These keep working unchanged and are removed in 3.0.0 ([#PR_PHASE2](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/PR_PHASE2)):

- `GET /api/admin/setup/status`, `POST /api/admin/setup`, `POST /api/admin/auth/login`, `POST /api/admin/auth/logout`,
  `GET /api/admin/auth/session` and `PUT /api/admin/auth/password`: use `GET /api/setup/status`, `POST /api/setup`,
  `POST /api/admin/login`, `POST /api/admin/logout`, `GET /api/admin/session` and `POST /api/admin/password`.
- The `code` and `issues` properties of error bodies: use `error` and `fields`.
- The `page` and `pageSize` parameters of the article lists, and the `page`, `pageSize` and `totalPages` fields they
  return: use `limit`, `cursor` and `nextCursor`.

### Removed

- The public **API reference** page at `/api-docs` and its footer link; the API reference is now shown only to the
  Admin, in the admin panel (API-14) ([#PR_PHASE2](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/PR_PHASE2)).
- The hand-written `docs/openapi.yaml` and `docs/openapi-admin.yaml`, replaced by `GET /api/openapi.json` ([#PR_PHASE2](https://github.com/agtdarkshadow04/agt_knowledge_base/pull/PR_PHASE2)).

### Security

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
