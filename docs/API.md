# AGT Knowledge Base API

This guide explains how to use the AGT Knowledge Base HTTP API: authentication, concurrency, visibility, pagination, errors, and limits. Per-route detail (every path, parameter, request body, and response schema) is in the OpenAPI 3.1 document the server generates from its route schemas, served at **`GET /api/openapi.json`** (API-11). The admin panel's **API** tab renders it for the signed-in Admin (API-14).

For contributors: the route table, with each route's TypeBox schemas, is `server/routes.ts` (schemas in `server/schemas.ts`); semantic request validation is in `src/lib/validation.ts`; domain types, roles, and visibility rules are in `server/domain.ts`; and every error body is built by `errorReply()` in `server/http.ts`. `server/test/openapi.test.ts` fails when a route is missing from the document or incomplete, and when an error code the server sends is missing from the `ErrorBody` schema or from this guide.

## Contents

- [Base URL and formats](#base-url-and-formats)
- [Member authentication](#member-authentication)
- [Admin authentication](#admin-authentication)
- [Deprecated paths](#deprecated-paths)
- [Roles and visibility](#roles-and-visibility)
- [Optimistic concurrency](#optimistic-concurrency)
- [Lists, filters, and pagination](#lists-filters-and-pagination)
- [Request validation](#request-validation)
- [Errors](#errors)
- [Limits and caching](#limits-and-caching)
- [Settings](#settings)
- [Backups](#backups)

## Base URL and formats

Every route is under `/api/` on the site's origin (API-1), for example `https://<host>/api/articles`. In development, Vite proxies `/api/` to the API on port 8081, so the same paths work at `http://localhost:5173/api/...`. The examples below use `$SITE` for the origin, for example `SITE=http://localhost:8080`.

Requests and responses are JSON (`application/json`; send `content-type: application/json` with every body), except the backup download and restore upload, which are ZIP archives. Timestamps are ISO 8601 strings in UTC ending in `Z`, and IDs are lowercase UUIDs. Successful deletes and a few other writes answer `204 No Content` with no body. `GET /api/health` answers `{ "status": "ok" }` when the API and its database are up (SRV-11).

Every route has one of three authentication modes, declared once in `server/routes.ts`:

| Mode | Credential | Routes |
| --- | --- | --- |
| Public (`none`) | None | `GET /api/health`, `GET /api/settings/public`, `GET /api/articles`, `GET /api/articles/{id}`, `GET /api/tags`, `GET /api/setup/status`, and sign-in: `POST /api/member/login`, `POST /api/setup`, `POST /api/admin/login` |
| Member (`member`) | The `agt_knowledge_base_member_session` cookie | Article and tag writes, revisions, `/api/tags/orphans`, `/api/member/*` |
| Admin (`admin`) | The `agt_knowledge_base_session` cookie | Every other `/api/admin/*` route |

Both are cookie sessions (AUTH-8): a random 32-byte token in an `HttpOnly`, `SameSite=Strict`, `Path=/` cookie, marked `Secure` on HTTPS (`session.secureCookie`). The server stores only the token's SHA-256, and a session lasts `session.ttlHours` (12 hours by default). Scripts in the page can never read a token (FE-3). The two cookies never cross: the member cookie is ignored on admin routes and the Admin cookie on member routes, so a member account cannot use the admin API, and the Admin cannot write articles. Bearer tokens are not accepted anywhere.

**CSRF header.** Every state-changing request (anything but `GET`) to `/api/admin/*`, `/api/setup` and the member routes, sign-in and sign-out included, must carry `x-agt-request: 1` (SEC-5). A request without it is rejected with `403 csrf` before authentication, rate limits or body parsing. Together with `SameSite=Strict` cookies and no CORS (SEC-6), this stops other sites from making a signed-in browser send state-changing requests.

A missing, unknown or expired session answers `401 unauthorized` and clears the stale cookie.

## Member authentication

Members (Editors and Moderators) sign in with their username (or email address) and password. A script can keep the cookie in a cookie jar:

```bash
curl -sS -c member.cookies -X POST "$SITE/api/member/login" \
  -H 'content-type: application/json' -H 'x-agt-request: 1' \
  -d '{"username":"atlas","password":"Correct-horse-1"}'
curl -sS -b member.cookies "$SITE/api/member/articles?search=portal"
curl -sS -b member.cookies -X POST "$SITE/api/articles" -H 'x-agt-request: 1' -H 'content-type: application/json' -d @article.json
```

- `POST /api/member/login` answers `{ sub, username, displayName, email, role }` and sets the member cookie. Wrong credentials and inactive accounts both answer `401 invalid_credentials`. It is rate-limited per client address (`rateLimits.login`, see [Limits and caching](#limits-and-caching)).
- `GET /api/member/session` returns the signed-in member.
- `POST /api/member/logout` ends the session on the server and clears the cookie.

A member's sessions all end when the Admin changes the member's role, deactivates the account, sets a new password, or deletes it (AUTH-4).

The 1.x bearer-token routes `POST /api/auth/login` and `GET /api/auth/session` were removed in 2.0.0 without a deprecation period: keeping tokens in `localStorage` was the security problem the cookie sessions fix (VER-10's security exception).

## Admin authentication

1. **Setup** (fresh installations only, AUTH-5): `GET /api/setup/status` reports `{ adminExists, setupPasswordConfigured }`. `POST /api/setup` with `{ setupPassword, username, password }` (`passwordConfirmation` is optional and must match when sent) creates the Admin and signs it in, answering `201` with the session body. It answers `503 setup_password_missing` when `AGT_KNOWLEDGE_BASE_SETUP_PASSWORD` is not set, `401 invalid_setup_password` for a wrong setup password, `400 validation_failed` when the new password is too weak or equals the setup password, and `410 setup_complete` once an Admin exists, even while the variable is still set. The setup password is never stored and never becomes the Admin password.
2. **Sign-in**: `POST /api/admin/login` with `{ username, password }` sets the `agt_knowledge_base_session` cookie. The username is compared exactly as stored, after trimming surrounding whitespace (AUTH-3).
3. **Session**: `GET /api/admin/session` returns `{ username, setupPasswordStillSet, version }`; `setupPasswordStillSet` means `AGT_KNOWLEDGE_BASE_SETUP_PASSWORD` should be removed (AUTH-6), and `version` is the app version.
4. **Sign-out**: `POST /api/admin/logout` ends the session on the server and clears the cookie.
5. **Password change**: `POST /api/admin/password` with `{ currentPassword, password }` ends every Admin session and returns a new cookie (AUTH-4). A wrong current password answers `401 invalid_credentials`.

```bash
curl -sS -c admin.cookies -X POST "$SITE/api/admin/login" \
  -H 'content-type: application/json' -H 'x-agt-request: 1' \
  -d '{"username":"admin","password":"Correct-horse-1"}'
curl -sS -b admin.cookies "$SITE/api/admin/stats"
```

**Passwords** (AUTH-2) are hashed with scrypt (`N = 2^15, r = 8, p = 1`) and stored as `scrypt$N$r$p$<salt>$<hash>`. Hashes from 1.x are verified with their old parameters and rehashed at the next successful sign-in.


## Deprecated paths

These 1.x paths still work, with the same request and response as in 1.x, and are marked `deprecated: true` in the OpenAPI document. They are removed in 3.0.0 (VER-10):

| Deprecated | Use instead |
| --- | --- |
| `GET /api/admin/setup/status` | `GET /api/setup/status` |
| `POST /api/admin/setup` | `POST /api/setup` |
| `POST /api/admin/auth/login` | `POST /api/admin/login` |
| `POST /api/admin/auth/logout` | `POST /api/admin/logout` |
| `GET /api/admin/auth/session` | `GET /api/admin/session` |
| `PUT /api/admin/auth/password` | `POST /api/admin/password` |
| `GET /api/settings` (1.x body) | `GET /api/settings/public` (see [Settings](#settings)) |

The `page` and `pageSize` list parameters and the `page`, `pageSize` and `totalPages` list fields (see [pagination](#lists-filters-and-pagination)), and the `code` and `issues` error properties (see [Errors](#errors)), are deprecated the same way, as are the 1.x fields of `/api/admin/settings` (see [Settings](#settings)), the `required` field of `GET /api/setup/status` (use `adminExists`) and the `setupPasswordSet` field of the Admin session (use `setupPasswordStillSet`).

## Roles and visibility

Members have one of two roles (`server/domain.ts`):

- **Editor**: reads Public, Internal, and AGT levels 0–1; creates articles; edits unprotected articles; assigns Public, Internal, or AGT levels 0–1.
- **Moderator**: reads everything; edits protected articles; assigns any level; pins, protects, verifies, restores revisions, deletes articles, and manages tags.

Visibility is either a legacy text level (`Public`, `Internal`, `Admin`) or an AGT numeric level (`0` Public, `1` Private, `2` Restricted, `3` Top Secret, `4` SLT Restricted, `5` SCC Restricted). Anonymous visitors read only `Public` and `0`, and only while `access.allowPublicBrowsing` is on (`403 public_browsing_closed` otherwise). An article the caller may not read answers `404 not_found`, exactly like one that does not exist.

## Optimistic concurrency

Every article has a `version` that increases with each change. Writes must say which version they are based on, and the API answers `409 conflict` instead of overwriting a concurrent change:

| Operation | Where the version goes |
| --- | --- |
| `PUT /api/articles/{id}` | `version` in the body (required on update) |
| `PATCH /api/articles/{id}/protection`, `/pinning`, `/verification` | `version` in the body |
| `POST /api/articles/{id}/revisions/{version}/restore` | `currentVersion` in the body; the path `version` is the revision to restore |
| `DELETE /api/articles/{id}` | `?version=` in the query string |
| `DELETE /api/articles/{id}/orphan-tags/{tagId}` | `?version=` in the query string |
| `PUT /api/admin/settings` | The settings `version` in the body |

On a conflict, reload the resource, reapply the change, and retry with the new version. An update that changes nothing answers `400 no_changes`.

**Server-owned fields.** `createdAt`, `createdBy`, `modifiedAt`, `modifiedBy`, pinning, protection, verification, and `version` itself are set by the server. They are never accepted in article bodies (`400 validation_failed`, field code `not_allowed`); protection, pinning, and verification change only through their own Moderator routes.

## Lists, filters, and pagination

`GET /api/articles`, `GET /api/member/articles`, and `GET /api/admin/articles` take the same query parameters and return one page at a time as `{ items, nextCursor, total }` (API-8):

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
| `limit` | 1–200 | `50` |
| `cursor` | The `nextCursor` of the previous page | first page |

Pinned articles always sort first, then the `sort` field, then the article ID as a tie-breaker, so pages never overlap or skip articles while others are added or changed. `nextCursor` is `null` on the last page. Send the same filters and sort with every page: a cursor made for another sort order, or one that cannot be decoded, answers `400 invalid_request`. `total` counts every article that matches the filters. Items are summaries with an `excerpt` instead of `content`; fetch an article by ID for its full Markdown.

**Deprecated:** `page` (1 or more) with `pageSize` (1–50, default 12) still returns that page with the 1.x fields `page`, `pageSize` and `totalPages`; it is removed in 3.0.0.

`GET /api/admin/users` takes `search` (username, display name, or email), `role` (`all`, `Editor`, `Moderator`), `active` (`all`, `active`, `inactive`), `page`, and `pageSize` (1–100, default 25); member accounts are created by the Admin, so the list stays small. Tag lists (`GET /api/tags`, `GET /api/member/tags`) take `search` (up to 40 characters) and return every match without pagination.

## Request validation

Each route declares TypeBox schemas for its path parameters, query string and body (API-10). Undeclared properties are rejected, not dropped, and values are never converted to another type. After that check, the shared Zod validators in `src/lib/validation.ts` apply the semantic rules. Either failure answers `400 validation_failed` with field errors (see [Errors](#errors)). The main constraints:

- **Articles**: `title` 3–180 characters (trimmed); `content` 20–250,000 characters of Markdown, with no raw HTML or JSX tags and no MDX `import`/`export` lines; `tagIds` up to 12 unique tag UUIDs that exist (field `tagIds`, code `not_allowed`, otherwise).
- **Tags**: `name` 1–40 characters (trimmed, unique: `409 conflict` with field `name`, code `duplicate`); `color` canonical `#RRGGBB` with uppercase hex digits.
- **Passwords** (members and the Admin): 12–1024 characters with a lowercase letter, an uppercase letter, a number, and a symbol. The Admin password must also differ from `AGT_KNOWLEDGE_BASE_SETUP_PASSWORD` (field `password`, code `same_as_setup_password`).
- **Usernames**: trimmed and lowercased, matching `^[a-z0-9_.-]{3,64}$`. Display names 1–120 characters; emails optional, up to 254 characters.
- **Path IDs**: a malformed ID names no resource and answers `404 not_found`, like an unknown one (API-5). Versions must be positive integers (field `version`, code `invalid_format`).

## Errors

Every error response has the same body (API-6):

```json
{
  "error": "validation_failed",
  "message": "The request is invalid: Title must contain at least 3 characters.",
  "fields": [
    { "field": "title", "code": "too_short", "message": "Title must contain at least 3 characters.", "params": { "min": 3 } }
  ],
  "code": "VALIDATION_ERROR"
}
```

| Property | Meaning |
| --- | --- |
| `error` | Stable snake_case code for programs; the table below lists them all |
| `message` | English text for people and logs; it may change |
| `params` | Values the text needs: `retryAfterSeconds` (`rate_limited`), `maxBytes` (`file_too_large`), `key` (`unknown_setting`, `invalid_setting`, `defined_in_config`) |
| `fields` | Field errors `{ field, code, message, params? }`; `field` is the request property, dotted for nested ones (`tagIds.2`) |
| `code` | **Deprecated**: the 1.x UPPER_SNAKE_CASE code (second column below). Removed in 3.0.0 |
| `issues` | **Deprecated**: the 1.x Zod issues of a semantic validation failure. Removed in 3.0.0 |

Field codes: `required`, `too_long` (`params.max`), `too_short` (`params.min`), `out_of_range` (`params.min`/`max`), `too_many` (`params.max`), `invalid_format`, `invalid_url`, `not_allowed`, `duplicate`, `mismatch` (`params.other`), `same_as_setup_password`.

`500 internal` never includes internal details; the server logs them with a request ID.

| Status | `error` | Deprecated `code` | Meaning |
| --- | --- | --- | --- |
| 400 | `invalid_request` | `INVALID_REQUEST`, `INVALID_JSON` | The body is missing or not valid JSON, a backup upload is empty, or a cursor cannot be used. |
| 400 | `validation_failed` | `VALIDATION_ERROR`, `INVALID_VERSION`, `INVALID_TAG_IDS`, `PASSWORD_REUSED`, `INVALID_ACTION` | The path, query or body fails validation; see `fields`. |
| 400 | `no_changes` | `NO_CHANGES` | An article update changes nothing. |
| 400 | `tag_not_orphaned` | `TAG_NOT_ORPHANED` | The tag is not an unresolved reference on that article. |
| 400 | `unknown_setting` | — | A settings update names a key (`params.key`) that is not a dashboard setting. |
| 400 | `invalid_setting` | `INVALID_SETTING` | A settings update gives a key (`params.key`) a value its schema does not allow. |
| 400 | `invalid_backup` | `INVALID_BACKUP` | The backup archive cannot be restored; the message says why. |
| 401 | `unauthorized` | `UNAUTHENTICATED` | The member or Admin session cookie is missing, unknown, or expired. |
| 401 | `invalid_credentials` | `INVALID_CREDENTIALS`, `INVALID_CURRENT_PASSWORD` | Wrong username or password (or an inactive member), or a wrong current password on the Admin password change. |
| 401 | `invalid_setup_password` | `INVALID_SETUP_PASSWORD` | The setup password is wrong. |
| 403 | `forbidden` | `FORBIDDEN` | The member's role does not allow the action. |
| 403 | `public_browsing_closed` | `PUBLIC_BROWSING_DISABLED` | Anonymous reads are turned off. |
| 403 | `csrf` | `CSRF_HEADER_REQUIRED` | The request lacks `x-agt-request: 1`. |
| 404 | `not_found` | `NOT_FOUND`, `INVALID_ID`, `INVALID_TAG_ID`, `INVALID_USER_ID`, `TAG_NOT_FOUND`, `USER_NOT_FOUND` | The route, article, revision, tag or member account does not exist, the ID is malformed, or the caller may not see the article. |
| 409 | `conflict` | `VERSION_CONFLICT`, `TAG_NAME_CONFLICT`, `USER_CONFLICT` | The article changed since it was read, or a name, username or email is taken. |
| 409 | `defined_in_config` | `SETTING_DEFINED_IN_FILE` | The setting (`params.key`) is defined in `config.yaml` and cannot be changed through the API. |
| 410 | `setup_complete` | `SETUP_ALREADY_COMPLETED` | An Admin already exists, so setup is closed (even while the setup password is still set). |
| 413 | `file_too_large` | `BODY_TOO_LARGE` | A backup upload exceeds `backup.maxZipBytes` (`params.maxBytes`). |
| 413 | `body_too_large` | `BODY_TOO_LARGE` | A JSON body exceeds 1 MB. |
| 429 | `rate_limited` | `RATE_LIMITED` | Too many attempts; wait `params.retryAfterSeconds` (also sent as `Retry-After`). |
| 503 | `setup_password_missing` | `SETUP_DISABLED` | `AGT_KNOWLEDGE_BASE_SETUP_PASSWORD` is not set on the server, so setup is unavailable. |
| 500 | `pre_restore_backup_failed` | `PRE_RESTORE_BACKUP_FAILED` | The pre-restore backup could not be written, so nothing was restored. |
| 500 | `internal` | `INTERNAL_ERROR` | An unexpected failure. |

## Limits and caching

**Body size.** JSON bodies are limited to 1 MB (`413 body_too_large`), except backup restore uploads, which may be up to the effective `backup.maxZipBytes` (100 MB by default; `413 file_too_large`). The limit is checked against `Content-Length` and while reading, after authentication, so anonymous clients cannot make the server buffer large bodies.

**Rate limits** (SEC-7, `@fastify/rate-limit`). These routes are limited per client address, right after the CSRF and session checks and before the body is read. An exceeded limit answers `429 rate_limited` with a `Retry-After` header (seconds). Limits are configured under `rateLimits.*` in `config.yaml`, are kept in memory, and reset when the API restarts. A deprecated path shares its replacement's limit.

| Route | `config.yaml` key | Default |
| --- | --- | --- |
| `POST /api/member/login` | `rateLimits.login` | 10 per 15 minutes |
| `POST /api/admin/login` | `rateLimits.login` (deprecated `rateLimits.adminLogin` overrides it) | 10 per 15 minutes |
| `POST /api/admin/password` | `rateLimits.login` (deprecated `rateLimits.adminPassword` overrides it) | 10 per 15 minutes |
| `POST /api/setup` | `rateLimits.setup` | 10 per 15 minutes |
| `POST /api/admin/backup/restore` | `rateLimits.adminUploads` | 120 per 15 minutes |

Each route has its own counter, so member sign-in attempts never use up the Admin's.

Client addresses come from `X-Forwarded-For` only when `server.trustProxy` allows it.

**Security headers and caching** (SEC-1..SEC-3). Every response carries the spec's Content-Security-Policy, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin` and `Cross-Origin-Opener-Policy: same-origin`. Every API and HTML response sends `Cache-Control: no-store, no-cache, must-revalidate, max-age=0`, `Pragma: no-cache` and `Expires: 0`; only the hashed files under `/assets/` are cached. The API sends no CORS headers and answers no preflight requests (SEC-6).

## Settings

The dashboard settings (CFG-6) are `site.title`, `site.subtitle`, `site.supportUrl`, `articles.defaultVisibility`, `access.allowPublicBrowsing`, `backup.maxZipBytes`, `backup.maxUncompressedBytes` and `backup.maxEntries`; `config.example.yaml` lists their defaults and allowed values. Each resolves to the value in `config.yaml` if the file sets it, otherwise the dashboard value, otherwise the default (CFG-7).

- `GET /api/settings/public` returns what the public UI needs, grouped as in `config.yaml`: `{ "site": { "title", "subtitle", "supportUrl" }, "articles": { "defaultVisibility" }, "access": { "allowPublicBrowsing" } }`.
- `GET /api/admin/settings` returns `states`: one `{ key, value, source, locked, default, description }` per setting, where `source` is `config`, `dashboard` or `default` and `locked` means `config.yaml` sets the key.
- `PUT /api/admin/settings` takes `{ "values": { "<key>": <value> | null } }`. `null` resets a key to its default. The whole request is refused, and nothing changes, if any key is not a dashboard setting (`400 unknown_setting`), is set in `config.yaml` (`409 defined_in_config`, message "`<key>` is defined in the configuration file and cannot be changed from the dashboard.") or has a value its schema does not allow (`400 invalid_setting`). It answers like `GET`.

```bash
curl -sS -X PUT "$SITE/api/admin/settings" -b admin.cookies \
  -H 'x-agt-request: 1' -H 'content-type: application/json' \
  -d '{"values":{"site.title":"Field Archive","backup.maxEntries":null}}'
```

Deprecated until 3.0.0 (VER-10): `GET /api/settings` (the 1.x body `{ applicationName, applicationSubtitle, defaultVisibility, allowPublicBrowsing, version }`), and in `/api/admin/settings` the response fields `version` (always `1`) and `settings` (the states by 1.x name, with `source: "file"` for `config`) and the 1.x request fields (`applicationName`, …, `backupMaxBytes` and `version`, which is ignored). A request may not mix `values` with 1.x fields.

## Backups

- `GET /api/admin/backup` downloads a ZIP of every application table (except Admin sessions) and the current `config.yaml`, named in `Content-Disposition` as `agt-kb-backup-<timestamp>.zip`.
- `POST /api/admin/backup/restore?action=preview` validates an archive and reports what a restore would do (migrations, row counts, the `config.yaml` difference, and settings `config.yaml` would override); nothing changes.
- `POST /api/admin/backup/restore?action=restore` writes a pre-restore backup of the current data to `storage.backupsDir`, then replaces all data with the archive. `config.yaml` is never restored, and every Admin session is cleared, so sign in again with the Admin account from the backup.

The restore body is the raw ZIP file, not a multipart form:

```bash
curl -sS -b admin.cookies -X POST "$SITE/api/admin/backup/restore?action=preview" \
  -H 'x-agt-request: 1' -H 'content-type: application/zip' \
  --data-binary @agt-kb-backup.zip
```

See the [Backups section of the README](../README.md#backups) for operational details.
