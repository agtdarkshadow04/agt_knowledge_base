# AGT Knowledge Base API

This guide explains how to use the AGT Knowledge Base HTTP API: authentication, concurrency, visibility, pagination, errors, and limits. Per-route detail (every path, parameter, request body, and response) is in the OpenAPI 3.1 descriptions:

- [`openapi.yaml`](openapi.yaml): public and member routes.
- [`openapi-admin.yaml`](openapi-admin.yaml): the installation Admin's routes (`/admin/*`).

The same descriptions are rendered in the apps: the member app's **API reference** page at `/api-docs` (linked from the footer) and the admin panel's **API** tab.

For contributors, the route table is `server/routes.ts`; request validation is in `src/lib/validation.ts`; domain types, roles, and visibility rules are in `server/domain.ts`; and error responses are built in `backend/api-response.ts` and `backend/server.ts`. `backend/openapi.test.ts` fails when the route table and the spec files disagree, and when an error code the backend returns is missing from this guide.

## Contents

- [Base URL and formats](#base-url-and-formats)
- [Member authentication](#member-authentication)
- [Admin authentication and CSRF](#admin-authentication-and-csrf)
- [Roles and visibility](#roles-and-visibility)
- [Optimistic concurrency](#optimistic-concurrency)
- [Lists, filters, and pagination](#lists-filters-and-pagination)
- [Request validation](#request-validation)
- [Errors](#errors)
- [Limits and caching](#limits-and-caching)
- [Backups](#backups)

## Base URL and formats

Behind Nginx the API is served under `/api` on the site's origin: the route `/articles` is `https://<host>/api/articles`. In development, Vite proxies `/api/` to the API on port 3001, so the same paths work at `http://localhost:5173/api/...`. The examples below use `$BASE` for that prefix, for example `BASE=http://localhost:8080/api`.

Requests and responses are JSON (`application/json; charset=utf-8`), except the backup download and restore upload, which are ZIP archives. Timestamps are ISO 8601 strings in UTC, and IDs are UUIDs. Successful deletes and a few other writes answer `204 No Content` with no body.

Every route has one of three authentication modes, declared once in `server/routes.ts`:

| Mode | Credential | Routes |
| --- | --- | --- |
| Public (`none`) | None | `GET /settings`, `GET /articles`, `GET /articles/{id}`, `GET /tags`, `POST /auth/login`, `GET /admin/setup/status`, `POST /admin/setup`, `POST /admin/auth/login` |
| Member (`member`) | `Authorization: Bearer <token>` | Article and tag writes, revisions, `/tags/orphans`, `/member/*`, `GET /auth/session` |
| Admin (`admin`) | The `agt_admin_session` cookie, plus `x-agt-request: 1` on non-GET requests | Every other `/admin/*` route |

The two credentials never cross: bearer tokens are ignored on admin routes, and the Admin cookie is ignored on member routes (it is scoped to `/api/admin`, so browsers do not even send it there). A member account cannot use the admin API, and the Admin cannot write articles.

## Member authentication

Members (Editors and Moderators) sign in with their username (or email address) and password, and receive a signed bearer token:

```bash
TOKEN=$(curl -sS -X POST "$BASE/auth/login" \
  -H 'content-type: application/json' \
  -d '{"username":"atlas","password":"Correct-horse-1"}' | jq -r .token)
```

The response is `{ "token": "...", "user": { "sub", "username", "displayName", "email", "role" } }`. Send the token on member routes:

```bash
curl -sS "$BASE/member/articles?search=portal" -H "authorization: Bearer $TOKEN"
```

`GET /auth/session` returns the signed-in member and is a cheap way to check whether a stored token is still valid. Tokens expire after `session.ttlHours` (12 hours by default) and stop working as soon as an Admin changes the member's role, deactivates the account, or sets a new password. A missing, invalid, or expired token answers `401 UNAUTHENTICATED`; sign in again.

`POST /auth/login` is rate-limited per client address (see [Limits and caching](#limits-and-caching)). Wrong credentials and inactive accounts both answer `401 INVALID_CREDENTIALS`.

## Admin authentication and CSRF

The installation Admin uses a cookie session instead of a bearer token, so the admin panel never stores a credential that page scripts can read.

1. **Setup** (fresh installations only): `GET /admin/setup/status` reports `{ required, setupPasswordConfigured }`. `POST /admin/setup` with `{ setupPassword, username, password, passwordConfirmation }` creates the Admin and signs it in. It requires `AGT_SETUP_PASSWORD` on the server (`403 SETUP_DISABLED` otherwise) and answers `409 SETUP_ALREADY_COMPLETED` once an Admin exists.
2. **Sign-in**: `POST /admin/auth/login` with `{ username, password }`. The response sets `agt_admin_session`: a random token in an `HttpOnly`, `SameSite=Strict` cookie with `Path=/api/admin`, marked `Secure` on HTTPS. The server stores only its SHA-256 hash. Sessions last `adminSession.ttlHours` (12 hours by default).
3. **Sign-out**: `POST /admin/auth/logout` revokes the session on the server and clears the cookie.
4. **Password change**: `PUT /admin/auth/password` with `{ currentPassword, password, passwordConfirmation }` revokes every Admin session and returns a new cookie.

**CSRF header.** Every non-GET request to `/admin/*`, including setup and sign-in, must carry `x-agt-request: 1`. Requests without it are rejected with `403 CSRF_HEADER_REQUIRED` before authentication or body parsing. Together with `SameSite=Strict`, this stops other sites from making the Admin's browser send state-changing requests.

A script can hold the cookie in a cookie jar:

```bash
curl -sS -c admin.cookies -X POST "$BASE/admin/auth/login" \
  -H 'content-type: application/json' -H 'x-agt-request: 1' \
  -d '{"username":"admin","password":"Correct-horse-1"}'
curl -sS -b admin.cookies "$BASE/admin/stats"
```

The cookie's `Path=/api/admin` means it is only sent for admin routes, so the cookie jar must be used with the `/api` prefix that Nginx serves. A missing or expired session answers `401 UNAUTHENTICATED` (and clears an expired cookie).

## Roles and visibility

Members have one of two roles (`server/domain.ts`):

- **Editor**: reads `Public`, `Internal`, `0`, and `1` articles; creates articles; edits unprotected articles; assigns only those four visibility levels.
- **Moderator**: everything an Editor can do, plus every visibility level (including `2`–`5` and legacy `Admin`), editing protected articles, protection, pinning, verification, restoring revisions, deleting articles, managing tags, and cleaning up unresolved tag references. The spec marks these operations with `x-required-role: Moderator`; an Editor receives `403 FORBIDDEN`.

The Admin is not a role: it manages member accounts, settings, statistics, and backups through the admin API, and can read the full article inventory (`GET /admin/articles`) but not write articles.

Article `visibility` is either a legacy text level or an AGT numeric level:

| Value | Meaning | Visible to |
| --- | --- | --- |
| `Public`, `0` | Public | Everyone, including anonymous visitors (when public browsing is on) |
| `Internal`, `1` | Internal / Private | Editors and Moderators |
| `2` | Restricted | Moderators |
| `3` | Top Secret | Moderators |
| `4` | SLT Restricted | Moderators |
| `5` | SCC Restricted | Moderators |
| `Admin` | Legacy; now Moderator-only | Moderators |

An article the caller may not see answers `404 NOT_FOUND`, exactly as if it did not exist. New articles default to `Internal` when `visibility` is omitted; the member app pre-fills the configured `defaultVisibility` from `GET /settings`.

**Public browsing.** When `allowPublicBrowsing` is off, the anonymous reads `GET /articles`, `GET /articles/{id}`, and `GET /tags` answer `403 PUBLIC_BROWSING_DISABLED`. Signed-in members use `GET /member/articles`, `GET /member/articles/{id}`, and `GET /member/tags`, which take the same parameters, are filtered for the member's role, and work regardless of the setting. `GET /settings` is always public.

## Optimistic concurrency

Every article has a `version` that increases with each change. Writes must say which version they are based on, and the API answers `409 VERSION_CONFLICT` instead of overwriting a concurrent change:

| Operation | Where the version goes |
| --- | --- |
| `PUT /articles/{id}` | `version` in the body (required on update) |
| `PATCH /articles/{id}/protection`, `/pinning`, `/verification` | `version` in the body |
| `POST /articles/{id}/revisions/{version}/restore` | `currentVersion` in the body; the path `version` is the revision to restore |
| `DELETE /articles/{id}` | `?version=` in the query string |
| `DELETE /articles/{id}/orphan-tags/{tagId}` | `?version=` in the query string |
| `PUT /admin/settings` | The settings `version` in the body |

On a conflict, reload the resource, reapply the change, and retry with the new version. An update that changes nothing answers `400 NO_CHANGES`.

**Server-owned fields.** `createdAt`, `createdBy`, `modifiedAt`, `modifiedBy`, pinning, protection, verification, and `version` itself are set by the server. They are never accepted in article bodies; protection, pinning, and verification change only through their own Moderator routes.

## Lists, filters, and pagination

`GET /articles`, `GET /member/articles`, and `GET /admin/articles` take the same query parameters and return `{ items, page, pageSize, total, totalPages }`:

| Parameter | Values | Default |
| --- | --- | --- |
| `search` | Full-text search, up to 200 characters | empty |
| `tagId` | A tag UUID | any tag |
| `visibility` | `all`, `public`, `internal`, `admin`, `0`–`5` | `all` |
| `pinned` | `all`, `pinned` | `all` |
| `protection` | `all`, `protected`, `unprotected` | `all` |
| `verification` | `all`, `verified`, `unverified` | `all` |
| `sort` | `createdAt`, `modifiedAt`, `title` | `modifiedAt` |
| `direction` | `asc`, `desc` | `desc` |
| `page` | 1 or more | `1` |
| `pageSize` | 1–50 | `12` |

Pinned articles always sort first. Items are summaries with an `excerpt` instead of `content`; fetch an article by ID for its full Markdown.

`GET /admin/users` takes `search` (username, display name, or email), `role` (`all`, `Editor`, `Moderator`), `active` (`all`, `active`, `inactive`), `page`, and `pageSize` (1–100, default 25). Tag lists (`GET /tags`, `GET /member/tags`) take `search` (up to 40 characters) and return every match without pagination.

## Request validation

Request bodies are parsed with strict Zod schemas (`src/lib/validation.ts`): unknown fields are rejected, and a failure answers `400 VALIDATION_ERROR` with the issues. The main constraints:

- **Articles**: `title` 3–180 characters (trimmed); `content` 20–250,000 characters of Markdown, with no raw HTML or JSX tags and no MDX `import`/`export` lines; `tagIds` up to 12 unique tag UUIDs that exist (`400 INVALID_TAG_IDS` otherwise).
- **Tags**: `name` 1–40 characters (trimmed, unique: `409 TAG_NAME_CONFLICT`); `color` canonical `#RRGGBB` with uppercase hex digits.
- **Passwords** (members and the Admin): 12–1024 characters with a lowercase letter, an uppercase letter, a number, and a symbol. The Admin password must also differ from `AGT_SETUP_PASSWORD` (`400 PASSWORD_REUSED`).
- **Usernames**: trimmed and lowercased, matching `^[a-z0-9_.-]{3,64}$`. Display names 1–120 characters; emails optional, up to 254 characters.
- **Path IDs** must be UUIDs (`400 INVALID_ID`, `INVALID_TAG_ID`, or `INVALID_USER_ID`), and versions positive integers (`400 INVALID_VERSION`).

## Errors

Every error response has the same body:

```json
{ "code": "VERSION_CONFLICT", "message": "The article has changed. Reload the latest version before saving." }
```

`code` is stable and meant for programs; `message` is for people and may change. `400 VALIDATION_ERROR` responses also include `issues`, the list of Zod issues (each with `path` and `message`). `500 INTERNAL_ERROR` never includes internal details; the server logs them with a request ID.

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `INVALID_REQUEST` | A required body is missing (or a backup upload is empty). |
| 400 | `INVALID_JSON` | The body is not valid JSON. |
| 400 | `VALIDATION_ERROR` | The body or query fails validation; see `issues`. |
| 400 | `INVALID_ID` | The article ID in the path is not a UUID. |
| 400 | `INVALID_TAG_ID` | The tag ID in the path is not a UUID. |
| 400 | `INVALID_USER_ID` | The member account ID in the path is not a UUID. |
| 400 | `INVALID_VERSION` | A version in the path or query string is not a positive integer. |
| 400 | `INVALID_TAG_IDS` | An article references a tag that does not exist. |
| 400 | `NO_CHANGES` | An article update changes nothing. |
| 400 | `TAG_NOT_ORPHANED` | The tag is not an unresolved reference on that article. |
| 400 | `PASSWORD_REUSED` | The new Admin password equals the setup password. |
| 400 | `INVALID_SETTING` | A setting that cannot be cleared was set to `null`. |
| 400 | `INVALID_ACTION` | `action` must be `preview` or `restore`. |
| 400 | `INVALID_BACKUP` | The backup archive cannot be restored; the message says why. |
| 401 | `UNAUTHENTICATED` | The member token or Admin session is missing, invalid, or expired. |
| 401 | `INVALID_CREDENTIALS` | Wrong username or password (or an inactive member). |
| 401 | `INVALID_SETUP_PASSWORD` | The setup password is wrong. |
| 403 | `FORBIDDEN` | The member's role does not allow the action. |
| 403 | `PUBLIC_BROWSING_DISABLED` | Anonymous reads are turned off. |
| 403 | `CSRF_HEADER_REQUIRED` | A non-GET admin request lacks `x-agt-request: 1`. |
| 403 | `SETUP_DISABLED` | `AGT_SETUP_PASSWORD` is not set on the server. |
| 403 | `INVALID_CURRENT_PASSWORD` | The current Admin password is wrong. |
| 404 | `NOT_FOUND` | The route, article, or revision does not exist, or the caller may not see the article. |
| 404 | `TAG_NOT_FOUND` | The tag does not exist. |
| 404 | `USER_NOT_FOUND` | The member account does not exist. |
| 409 | `VERSION_CONFLICT` | The article or settings changed since they were read. |
| 409 | `TAG_NAME_CONFLICT` | Another tag already has this name. |
| 409 | `USER_CONFLICT` | Another member already has this username or email. |
| 409 | `SETUP_ALREADY_COMPLETED` | An Admin already exists. |
| 409 | `SETTING_DEFINED_IN_FILE` | The setting is defined in `config.yaml` and cannot be changed through the API. |
| 413 | `BODY_TOO_LARGE` | The body exceeds the route's limit. |
| 429 | `RATE_LIMITED` | Too many attempts; wait for `Retry-After` seconds. |
| 500 | `PRE_RESTORE_BACKUP_FAILED` | The pre-restore backup could not be written, so nothing was restored. |
| 500 | `INTERNAL_ERROR` | An unexpected failure. |

## Limits and caching

**Body size.** Request bodies are limited to 1 MB (`413 BODY_TOO_LARGE`), except backup restore uploads, which may be up to the effective `backup.maxBytes` (100 MB by default). The limit is checked against `Content-Length` and while reading, after authentication, so anonymous clients cannot make the server buffer large bodies.

**Rate limits.** These routes are limited per client address, before authentication and before the body is read. An exceeded limit answers `429 RATE_LIMITED` with a `Retry-After` header (seconds). Limits are configured under `rateLimits.*` in `config.yaml`, are kept in memory, and reset when the API restarts.

| Route | `config.yaml` key | Default |
| --- | --- | --- |
| `POST /auth/login` | `rateLimits.login` | 5 per minute |
| `POST /admin/auth/login` | `rateLimits.adminLogin` | 10 per 15 minutes |
| `POST /admin/setup` | `rateLimits.setup` | 10 per 15 minutes |
| `PUT /admin/auth/password` | `rateLimits.adminPassword` | 10 per 15 minutes |

Client addresses come from `X-Forwarded-For` only when `server.trustProxy` allows it.

**Caching.** Successful public reads of `GET /settings`, `GET /articles`, and `GET /articles/{id}` send `Cache-Control: public, max-age=30`, so a public change can take up to 30 seconds to appear for anonymous visitors. Every other response, including all member and admin responses and all errors, sends `Cache-Control: no-store`.

**Settings precedence.** Dashboard-editable settings resolve to the value in `config.yaml` if the file sets it, otherwise the dashboard value, otherwise the default. `GET /admin/settings` reports each setting's `key`, `value`, and `source` (`file`, `dashboard`, or `default`). `PUT /admin/settings` rejects a change to any key the file defines with `409 SETTING_DEFINED_IN_FILE`, and `null` clears a backup limit's dashboard value so its default applies again.

## Backups

- `GET /admin/backup` downloads a ZIP of every application table (except Admin sessions) and the current `config.yaml`, named in `Content-Disposition` as `agt-kb-backup-<timestamp>.zip`.
- `POST /admin/backup/restore?action=preview` validates an archive and reports what a restore would do (migrations, row counts, the `config.yaml` difference, and settings `config.yaml` would override); nothing changes.
- `POST /admin/backup/restore?action=restore` writes a pre-restore backup of the current data to `storage.backupsDir`, then replaces all data with the archive. `config.yaml` is never restored, and every Admin session is cleared, so sign in again with the Admin account from the backup.

The restore body is the raw ZIP file, not a multipart form:

```bash
curl -sS -b admin.cookies -X POST "$BASE/admin/backup/restore?action=preview" \
  -H 'x-agt-request: 1' -H 'content-type: application/zip' \
  --data-binary @agt-kb-backup.zip
```

See the [Backups section of the README](../README.md#backups) for operational details.
