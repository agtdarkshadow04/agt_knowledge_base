# Changelog

All notable changes to AGT Knowledge Base are documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html), as described in §21 of the
[AGT Web Application Specification](docs/agt-webapp-spec.md).

## [1.0.0] - Unreleased

The first version recorded in this file. It has not been tagged yet (VER-11), so the work to comply with the AGT Web
Application Specification v6.0.0 ([#48](https://github.com/agtdarkshadow04/agt_knowledge_base/issues/48)) is
recorded here until the first release.

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

### Changed

- The API now runs on Fastify 5 instead of a hand-written Node.js HTTP server, with the same routes, authentication,
  CSRF checks, rate limits, body limits and error bodies. Unexpected errors are logged as JSON lines on standard
  output and always answer `500 INTERNAL_ERROR` with the same message. The Docker images now use Node.js 26
  ([#48](https://github.com/agtdarkshadow04/agt_knowledge_base/issues/48)).
- Building or developing from source needs Node.js 26 and npm 11.20 or newer within npm 11; `npm ci` stops with an
  engine error on older versions. The API is started for development with `npm run dev:server` instead of
  `npm run api:dev`, and `npm run check` runs every check
  ([#48](https://github.com/agtdarkshadow04/agt_knowledge_base/issues/48)).

### Security

- Updated `zod` and the `dompurify` dependency of `html2pdf.js` to versions without known vulnerabilities
  ([#48](https://github.com/agtdarkshadow04/agt_knowledge_base/issues/48)).
