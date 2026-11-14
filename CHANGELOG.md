# Changelog

All notable changes to AGT Knowledge Base are documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html), as described in §21 of the
[AGT Web Application Specification](docs/agt-webapp-spec.md).

## [1.0.0] - Unreleased

The first version recorded in this file: the self-hosted application as it runs today, before the work to comply
with the AGT Web Application Specification v6.0.0
([#48](https://github.com/agtdarkshadow04/agt_knowledge_base/issues/48)). It has not been tagged yet (VER-11).

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
