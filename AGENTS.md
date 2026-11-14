# Agent guide — AGT Knowledge Base

AGT Knowledge Base is a TypeScript knowledge base for the Alliance of Galactic Travellers: a React 19 + Vite member
UI (`index.html` → `src/`) and a separate admin panel entry (`admin.html` → `src/admin/`), both served, with the REST
API under `/api/`, by a **Fastify 5** server (`server/`, Node.js 26, TypeScript) in front of PostgreSQL. The API is
described by an OpenAPI 3.1 document generated from its TypeBox route schemas (`GET /api/openapi.json`). There are two kinds of account. **Members**
(`local_users`, roles `Editor` and `Moderator`) sign in at `/login`. The single installation **Admin** (the one-row
`admin` table) signs in only at `/admin` with an HttpOnly cookie session (`admin_sessions`), manages members,
settings and backups, and is never a member `Actor`. Moderators hold every content-moderation power (protection,
pinning, verification, restore, delete, tags, visibility levels 2–5 and legacy `Admin`). No cloud services: the
former AWS deployment has been removed, and no code, package or schema name may depend on AWS again.

**Database: PostgreSQL** (DATA-2), because many members edit at the same time: sustained concurrent writes from many
users, which also need Postgres full-text search and row-level optimistic concurrency control (`version` checks with
`409`). Users are keyed by `app_users.user_id` (migration `011` renamed it from `cognito_sub`; migrated Cognito
subjects keep their values). Deployment today: Docker Compose with three images (Nginx `web`, `api`, one-shot
`migrate`) and `postgres:16`; see `README.md`.

This app follows the **[AGT Web Application Specification](docs/agt-webapp-spec.md) v6.0.0**
(`agtdarkshadow04/agt_webapp_specification@v6.0.0`). Read it before changing architecture, API, security, UI or
deployment. `docs/agt-webapp-spec.md` is a pinned copy of that tag: never edit it (SPEC-2). Propose rule changes as a
PR to the spec repository (SPEC-4); move to a newer spec version in a PR of its own (SPEC-3). The app does not meet
the spec yet: every unmet rule is listed under [Deviations](#deviations-from-the-agt-web-app-spec) below, and
issue #48 plans the phases that remove the "to fix" rows. Code written now should move towards the spec, not away
from it. Security expectations also live in `SECURITY.md`.

## Branches

- `main` is the default branch. Work on a feature branch and open a PR into `main`.
- `staging` is frozen: AWS Amplify builds the existing AWS test deployment from it. Never push to, merge into,
  rebase or delete `staging` (WF-1).

## Commands

Requires Node.js 26 and npm 11.20 or newer within npm 11 (`engines`, `engine-strict=true` in `.npmrc`). Install with
`npm ci`.

```bash
npm run check       # lint + test + build — run this before every commit
npm run lint        # tsc -b over the app, node and server projects (strict, no unused symbols; no ESLint)
npm test            # test:client (src/lib/*.test.ts) + test:server (server/test/*.test.ts) + test:components
npm run test:components  # Vitest + jsdom for the React components (~25 s)
npm run build       # Vite build → dist/, server bundle → dist-server/index.mjs
npm run dev:server  # build and run the API on 127.0.0.1:8081 (needs PostgreSQL and the variables in .env.local)
npm run dev         # Vite dev server on :5173, proxies /api/ to :8081
npm run db:migrate  # apply migrations (only when explicitly asked; never against a real database otherwise)
```

Run a single test file:

```bash
npx esbuild server/test/routes.test.ts --bundle --platform=node --target=node26 --format=esm --packages=external --loader:.sql=text --outdir=.test-build/server --out-extension:.js=.mjs && node --test .test-build/server/routes.test.mjs
npx vitest run src/pages/HomePage.test.tsx   # one component test; add -t "name" for one test
```

No check needs a database, Docker or network access beyond `npm ci`. CI (`.github/workflows/ci.yml`) runs `npm ci`,
the install-script check (STACK-7) and `npm run check`, and builds both Docker images, on pull requests and pushes to
`main`.

## Where things live

| Path | Purpose |
| --- | --- |
| `docs/agt-webapp-spec.md` | Pinned copy of the AGT Web Application Specification v6.0.0 (tag `v6.0.0`). Never edit; `.gitattributes` keeps it byte-identical |
| `CHANGELOG.md` | Release notes (Keep a Changelog 1.1.0), newest first (VER-9) |
| `server/index.ts` | Entry point and the only server file that reads `process.env`: builds the `AppContext` from `loadStartup()`, logs deprecation warnings, listens, shuts down on SIGTERM/SIGINT |
| `server/startup.ts` | `loadStartup(env)`: the CFG-2 `AGT_KNOWLEDGE_BASE_*` variables (and their deprecated 1.x names), `config.yaml` loading and the database settings, for `server/index.ts` and `scripts/` |
| `server/app.ts` | `buildApp(context, options)`: the Fastify app without `listen()` — route registration, the one authentication `onRequest` hook (rate limits, CSRF, member token, Admin cookie), body limits, the single error handler, and the sign-in/setup/session/logout/password routes it serves itself |
| `server/context.ts` | `AppContext` (config, config file text, database, setup password, member-token secret, version) and the settings precedence: `setting()`, `settingStates()`, `settingValues()`, `lockedSettingKeys()` (CFG-7) |
| `server/http.ts` | `HttpError(statusCode, error, message, { fields, params, legacyCode })` and `errorReply()`, the one mapping from errors to the API-6 error body |
| `server/routes.ts` | Route table: path under `/api/`, auth mode, `operationId`, tag, summary, TypeBox schemas, rate limit, and `replacedBy` for deprecated 1.x paths; the `ApiRequest`/`ApiResponse` types |
| `server/schemas.ts` | TypeBox request and response schemas of every route, `ErrorBody`/`FieldError`, and `errorCodes` (every code the server sends) |
| `server/openapi.ts` | `@fastify/swagger` registration and the `SECURITY` values each route declares (API-11) |
| `server/pagination.ts` | Opaque article-list cursors (API-8) |
| `server/config.ts` | `config.yaml`: its TypeBox schema with the CFG-5 keys (unknown keys are errors), the deprecated 1.x key names, and `EDITABLE_SETTINGS` (CFG-6) |
| `server/auth.ts` | `authenticate()`, the only place a member bearer token becomes a user; `requireActor` / `requireAdminSession` |
| `server/admin-auth.ts` | Admin setup (`AGT_KNOWLEDGE_BASE_SETUP_PASSWORD`), sign-in and SHA-256-hashed cookie sessions |
| `server/local-auth.ts` | Password hashing and `LocalAuthService` (member sign-in, signed member tokens) |
| `server/handler.ts`, `server/admin-handler.ts` | Public/member and `/admin/*` route dispatchers built from the context. The Admin handler never reads `request.actor` |
| `server/*-service.ts` | Domain logic, built with the context. `settings-service.ts` reads and writes the `settings` table (CFG-8) and the public settings; `backup-service.ts` + `backup-archive.ts` export, preview and restore ZIP backups |
| `server/domain.ts` | Types, visibility access rules, domain `HttpError` subclasses; re-exports the shared types from `src/lib/api.ts` |
| `server/db.ts` | `Database` (lazily created `pg.Pool`) and `createDatabase()` |
| `server/repository.ts`, `server/postgres-article-repository.ts` | Repository interfaces and all article/tag SQL (`admin-service.ts` holds the member-account SQL) |
| `server/migrations.ts`, `server/migrations-runner.ts`, `migrations/*.sql` | Inline migration SQL that actually runs, its runner, and reviewable SQL copies |
| `server/rate-limit.ts`, `server/line-diff.ts` | Rate limiter (keyed by Fastify's `request.ip`, which honours `server.trustProxy`), revision diff |
| `server/test/` | `node:test` server tests; `helpers.ts` has `testContext()`, `fakeDatabase()`, `assertMatches()`, `rejectsMatching()`, `match.*`, `respond()` |
| `src/lib/` | Code shared by server and browser (REPO-3): `validation.ts` (Zod request parsing; change rules here only), `api.ts` (shared request types and roles), `errors.ts` (`FieldError`, field codes, Zod issues → field errors), `openapi.ts` (reads the OpenAPI document for the admin API tab), with `node:test` tests in `*.test.ts` |
| `scripts/` | `migrate.ts` and the member-account recovery CLI `manage-local-user.ts`, bundled by `npm run build:scripts` (and the Dockerfile) |
| `src/` | Member UI: `pages/`, `components/` (`MarkdownContent.tsx`, `RichMarkdownEditor.tsx`), `auth/`, `settings/`, `services/api.ts` (member API client), `types.ts`, `visibility.ts` (display options and colours); component tests (`*.test.tsx`) run in Vitest + jsdom with `src/test/setup.ts` |
| `src/admin/` | Admin panel: `AdminApp` (setup/login/dashboard), `*Panel.tsx` tabs (`ApiPanel.tsx` + `api-docs/` render `/api/openapi.json`, API-14), `api.ts`, `types.ts`. The member bundle must never import from `src/admin/` |
| `docs/API.md` | API guide: authentication, deprecated paths, pagination, error codes (every code in `errorCodes` must be listed) |
| `config.example.yaml` | Every `config.yaml` key with its default |
| `Dockerfile`, `docker-compose.yml`, `nginx.conf`, `.env.example`, `docker.env.example` | Docker deployment and its environment templates |
| `.github/workflows/ci.yml` | CI |

## Conventions and gotchas

- **Versioning (§21):** every PR that ships changes (code, assets, migrations, `Dockerfile`, `docker-compose.yml`,
  `nginx.conf`, `config.example.yaml`) bumps the version with `npm version X.Y.Z --no-git-tag-version` and adds its
  entries under `## [X.Y.Z] - Unreleased` in `CHANGELOG.md`; the PR description states the level and rule (VER-8,
  VER-9). Docs-only, test-only, CI and `AGENTS.md` changes need no bump (VER-6). Removing or renaming a config key,
  environment variable, route, parameter or field needs a deprecation in an earlier minor release first (VER-10).
  Create tags and GitHub Releases only when the maintainer asks (VER-12).
- **Spec work:** cite rule IDs in commits and PRs (WF-2). When a PR makes a deviation below go away, delete its row in
  the same PR; when it adds one, add a row. One concern per PR (WF-3); the #48 phases are one PR each.
- TypeScript `strict`, ES modules. No Prettier: match the surrounding style (2-space indent, single quotes,
  semicolons, trailing commas).
- TypeScript is `strict` with `noUnusedLocals`, `noUnusedParameters` and `noFallthroughCasesInSwitch`; lint fails on
  unused symbols. Server and scripts import relative files with a `.js` extension
  (`import { HttpError } from './http.js';`); frontend imports under `src/` are extensionless, and files in `src/lib/`
  that the server imports use `.js` too.
- **Server structure (SRV-1..SRV-3):** only the entry points (`server/index.ts`, `scripts/*.ts`) read `process.env`,
  and they pass it to `loadStartup()` in `server/startup.ts`, which alone interprets variables and decides where the
  config file lives. A new environment variable must be in the CFG-2 set or an `AGT_KNOWLEDGE_BASE_<NAME>` secret.
  Everything else gets what it needs from the `AppContext` passed to `buildApp()` (services take the context, or the
  parts of it they use, in their constructor); never add a module-level pool, config cache or `process.env` read.
- Request input is checked twice: the route's TypeBox schema (types, required properties, no undeclared properties;
  `removeAdditional` and `coerceTypes` are off, so nothing is silently dropped or converted), then the semantic Zod
  parsers in `src/lib/validation.ts` (shared with the browser; never duplicate a rule). Signal failures by throwing
  `HttpError` (`server/http.ts`) or a domain subclass from `server/domain.ts`, with a snake_case `error` code (API-6)
  that is listed in `errorCodes` and `docs/API.md`, and `fields` for field errors; a code that replaces a 1.x code
  passes it as `legacyCode` until 3.0.0. Handlers never build error responses themselves, and `errorReply()` is the
  only place that maps errors to bodies.
- **Response schemas list every field** a route returns: Fastify's serializer drops undeclared ones, so a field added
  to a service result must be added to its schema in `server/schemas.ts` too.
- Keep SQL in `postgres-article-repository.ts` (or `admin-service.ts` for local users), always parameterized; map
  user-supplied sort fields through the existing allowlist.
- Keep changes minimal and consistent with existing patterns; a new runtime dependency needs a reason in the PR
  (STACK-1).
- **Tests:** server tests live in `server/test/*.test.ts` and `src/lib` tests next to their file; both use `node:test`
  and `node:assert/strict`, are bundled by esbuild into `.test-build/`, and read repository files by paths relative to
  the repository root (never `import.meta.url`). Build test contexts with `testContext()` and fake databases with
  `fakeDatabase()` from `server/test/helpers.ts`; use `mock.fn()` for spies, `assertMatches()` / `rejectsMatching()`
  for partial matches (same rules as Vitest's `toMatchObject`), and `buildApp()` with `inject()` or `listen({ port: 0 })`
  for HTTP. Extend `MemoryRepository` (`server/test/article-service.test.ts`) and `MemoryTagRepository`
  (`server/test/tag-service.test.ts`) when a repository interface changes. React component tests (`src/**/*.test.tsx`)
  still run in Vitest + jsdom with Testing Library, one worker and no file parallelism (see Deviations). Changes to role handling,
  protected-article rules, visibility, Markdown rendering, SQL construction or optimistic concurrency need regression
  tests (`SECURITY.md`). Never skip or weaken a test to make a change pass (TEST-5).
- **Adding or changing an API route:**
  1. `server/routes.ts`: add it under `/api/` with `auth: 'member'`, `auth: 'admin'` (path must start with
     `/api/admin/`) or `auth: 'none'`, a unique camelCase `operationId`, a tag, a one-sentence summary, and TypeBox
     schemas (`server/schemas.ts`) for its params, query string, body and success response. `buildApp()` registers
     every table entry on Fastify with the matching `security` (API-11). Every non-GET `/api/admin/*` request and
     `POST /api/setup` must carry `x-agt-request: 1` (the `onRequest` hook in `app.ts` enforces it). Add `rateLimit`
     for credential-checking routes. Renaming a route keeps the old path as an entry with `replacedBy` until the next
     major version (VER-10).
  2. Member/public routes go in `server/handler.ts` (roles via `requireActor` and the services); admin routes in
     `server/admin-handler.ts`. `server/test/routes.test.ts` fails if the table and the switches disagree. Routes that
     `app.ts` serves itself (sign-in, session, setup, logout, password) are listed in `serverRoutes` there.
  3. Client: `src/services/api.ts` + `src/types.ts` (member), `src/admin/api.ts` + `src/admin/types.ts` (admin).
  4. Docs: the OpenAPI document is generated; `server/test/openapi.test.ts` (API-13) fails if a route is missing or
     incomplete, its security is wrong, or an error code is missing from `errorCodes` or `docs/API.md`. Update
     `docs/API.md` for new concepts.
  5. Tests in `server/test/`: `handler.test.ts` / `admin-handler.test.ts` (authorization), `server.test.ts` (session
     separation, CSRF, cookies, body and rate limits), `routes.test.ts` (routing and auth modes).
- **Adding a database migration:** append the next `NNN_snake_case` entry to `migrations` in `server/migrations.ts`
  (this inline SQL is what runs), add the matching `migrations/NNN_snake_case.sql` wrapped in `BEGIN;`/`COMMIT;`, and
  update `server/test/migrations-runner.test.ts`. Never edit a shipped migration. Destructive (contract-phase) migrations
  set `requiresExplicitTarget: true`. Never schema-qualify objects (`public.`) or set `search_path`: backup restore
  replays migrations inside a staging schema; `migrations-runner.test.ts` checks this. Do not add functions, triggers,
  views or extensions (DATA-11).
- **Article visibility:** legacy text levels (`Public`, `Internal`, `Admin`) and AGT numeric levels (`0`–`5`) are both
  supported. Access rules live in `server/domain.ts`, display options and colours in `src/visibility.ts`; keep them in
  sync and preserve legacy behaviour.
- **Authentication:** local accounts only; `AUTH_MODE` other than `local` stops the server. Handlers get the `Actor`
  on `request.actor` and never inspect tokens. The `onRequest` hook in `app.ts` verifies the Admin cookie for `auth: 'admin'` routes and
  passes `request.admin`. Bearer tokens are ignored on admin routes and the Admin cookie on member routes; never let
  one grant the other.
- **Configuration:** non-secret settings live in `config.yaml` (document every key, commented out, in
  `config.example.yaml`; `server/test/config.test.ts` checks it); secrets stay in environment variables. Renaming a
  key adds it to `renamedKeys` in `server/config.ts` until the next major (VER-10). A dashboard-editable setting is an
  `EDITABLE_SETTINGS` entry (schema, default, description) plus its `config.yaml` key and the `CHECK` list of the
  `settings` table (a new migration); it resolves config file → `settings` table → default only in `settingStates()`,
  and a key the file defines must never be changeable through any API, migration or restore.
- **Security (do not weaken, WF-4):** the API is the authorization boundary; UI hiding is never access control.
  Never commit `.env` files, secrets, database URLs or credentials; `VITE_*` values are public. Markdown is rendered
  without raw HTML and the API rejects HTML/JSX/MDX imports: never enable raw HTML or execute content as MDX, and
  never use `dangerouslySetInnerHTML` for user content. Updates, restores and deletes carry the article `version` and
  return `409` on mismatch. Server-owned fields (`created_at`, `created_by`, `modified_at`, `modified_by`, pinning,
  protection, version) are never accepted from clients, except by the Admin backup restore, which restores rows
  verbatim. No outbound requests from the server and no CDN assets in the client (SEC-14).
- **Backups:** a new table goes into `backupTables` in `server/backup-service.ts` in foreign-key order. Only
  `admin_sessions` is listed in `unbackedTables`: never backed up, cleared by every restore. `config.yaml` is included
  in backups but never restored.
- The app has no anonymous writes (so no ALTCHA, §11), no file uploads other than backup archives (SEC-9), and shows
  no portal codes (UI-14).
- Update `README.md` when a change affects setup, configuration, roles/permissions or user-visible behaviour.
- Commit subjects are short and imperative (`Add AGT-standard visibility levels`), with `Refs #<issue>` in the body
  when working from an issue.

## Deviations from the AGT web app spec

Rule IDs refer to the pinned v6.0.0 copy. The first two rows are permanent and agreed in issue #48. Every row
marked **To fix** names the #48 phase, or the major release, that removes it; delete the row in that PR.

| Rule | What differs | Why |
| --- | --- | --- |
| AUTH-1 | Besides the single Admin there are **member accounts** (`local_users`, roles `Editor` and `Moderator`). Consequences, all reusing the spec's own mechanisms: members sign in with AUTH-8 cookie sessions (cookie `agt_knowledge_base_member_session`, same attributes as the Admin cookie; table `member_sessions`; routes `/api/member/login`, `/api/member/logout`, `/api/member/session`), accepted only on member routes by one `onRequest` hook and never in place of the Admin cookie or the reverse; `x-agt-request: 1` on every member write (SEC-5); `rateLimits.login` with its own counter (SEC-7); AUTH-2/AUTH-3 password rules, with old member hashes rehashed on the next sign-in; a password reset, deactivation, role change or deletion by the Admin ends all of that member's sessions (AUTH-4); member sessions are never backed up and are emptied by a restore (BAK-2, BAK-4); OpenAPI adds the `memberSessionCookie` scheme (member reads `[{ memberSessionCookie: [] }]`, writes `[{ memberSessionCookie: [], csrfHeader: [] }]`, login `[{ csrfHeader: [] }]`), checked by the API-13 test (API-11); the audit log records `actor_type: member` with the username, and member 401/403 responses like admin ones (LOG-10, LOG-11) | Members writing and moderating articles are what the product is for. Nothing else is loosened. Until Phase 4 the member mechanism itself still deviates (see the AUTH-8 / FE-3 row) |
| STACK-3, UI-9, A11Y-2 | `@mdxeditor/editor` brings its own toolbar, select and link-dialog components (Radix-based) instead of `.button`/`.modal-*` classes and `useDialog` | Rich Markdown editing is a core feature, and no reasonable plain-React replacement exists. Limits: used only inside the article editor; styled with AGT tokens through its own CSS variables, never by overriding UI-9 classes; its popovers must still pass the TEST-6 checks (keyboard opening, Escape closes, focus returns, axe WCAG 2.2 AA) |
| NAME-1, §2.1 | **To fix (Phase 0):** the slug `knowledge-base` (AGT Knowledge Base, `agtdarkshadow04/agt_knowledge_base`, default port **8081**, PostgreSQL) is not in the spec's app registry yet | Needs a registry PR in the spec repository (SPEC-4) |
| STACK-1, TEST-1, TEST-3 | **To fix (Phase 10):** the React component tests (`src/**/*.test.tsx`) run in Vitest + jsdom + Testing Library (`npm run test:components`, part of `npm test`), with the dev dependencies `vitest`, `jsdom` and `@testing-library/*`; `package.json` also has the scripts `test:components`, `build:scripts` and `db:migrate` | The spec's client tests run in plain Node without a DOM. Phase 10's Playwright suite (TEST-6) replaces these tests; removing them earlier would lose coverage (TEST-5) |
| SRV-4 | **To fix (Phase 5):** SQL also lives in `admin-auth.ts`, `local-auth.ts`, `admin-service.ts`, `settings-service.ts`, `backup-service.ts` and `migrations-runner.ts`, not only in the repository | Predates the spec |
| REPO-1, FE-6, FE-8 | **To fix (Phases 4–10):** the layout still has `scripts/`, `migrations/*.sql` mirrored into `server/migrations.ts` (Phase 5), `src/services/`, `src/pages/` and logic outside `src/lib/` such as `src/visibility.ts` (Phase 8), `nginx.conf` and `docker.env.example` (Phase 10); server files are named after the current pipeline (`handler.ts`, `admin-handler.ts`, `admin-auth.ts`, `local-auth.ts`) rather than `adminRoutes.ts`, `session.ts`, `passwords.ts` (Phase 4); forms do not validate with `src/lib/validation.ts` yet (Phase 8) | Predates the spec |
| API-1, API-2, API-3, API-6, API-8 | **To fix (3.0.0):** the 1.x paths `/api/admin/setup/status`, `/api/admin/setup`, `/api/admin/auth/login`, `/logout`, `/session` and `PUT /api/admin/auth/password` still work next to their API-1 replacements; error bodies still carry the 1.x `code` and `issues` beside `error`/`fields`; article lists still accept `page`/`pageSize` and then return `page`, `pageSize`, `totalPages`; admin user create/replace return the user, not `{ user, notices }`, a member's password is set with `PUT …/password`, not an action `POST`, and article flags change with `PATCH …/protection`, `/pinning`, `/verification`; public article responses use the member schema, which includes the `createdBy`/`modifiedBy` user IDs; `GET /api/settings` and the 1.x `version`/`settings` fields of `/api/admin/settings` still work next to `GET /api/settings/public`, `states` and `values`. CFG-2, CFG-5: the 1.x `config.yaml` keys (`site.applicationName`, `site.applicationSubtitle`, `backup.maxBytes`, `adminSession.*`, `rateLimits.adminLogin`/`adminPassword`, `server.frontendOrigin`) and environment variables (`AGT_SETUP_PASSWORD`, `CONFIG_FILE`, `DB_*`, `DATABASE_URL`, `DATABASE_SSL`, `LOCAL_USER_PASSWORD`, `AUTH_MODE`) are still read, with a startup warning, and Compose still passes `DB_NAME`/`DB_USER` | Each is a rename or removal that VER-10 lets a major version make only after a deprecation period; all are deprecated in 2.0.0 (`deprecated: true` in OpenAPI, startup warnings, `CHANGELOG.md`) |
| CFG-5, CFG-6 | **To fix (Phases 6, 7, 10):** the `backup.*` limits keep their 1.x ranges and defaults (`maxZipBytes` at most 1 GiB, default 100 MB; `maxUncompressedBytes` at most 500 MB, default 256 MB; `maxEntries` 3–10000, default 16) while backups are a JSON dump parsed in memory, and `database.previewName` is not used yet (Phase 6); no `logs.*` keys (Phase 7); `server.trustProxy` also accepts a number of proxy hops, for the Compose stack's Nginx (Phase 10) | The spec's 8 GiB uncompressed limit needs the `pg_dump` format; the hop count goes with Nginx |
| CFG-2, NAME-2, DEP-3, DEP-4 | **To fix (Phases 4–10):** `LOCAL_AUTH_SECRET` is not `AGT_KNOWLEDGE_BASE_`-prefixed (Phase 4 removes it); `MIGRATION_TARGET_ID` (Phase 5); Compose reads `POSTGRES_*` and `APP_*` from `.env` and passes `POSTGRES_PASSWORD` to the server as `AGT_KNOWLEDGE_BASE_DB_PASSWORD`, with `docker.env.example` beside `.env.example` and no `.env.db` (Phase 10, with the DEP-3 database role in Phase 5); volumes (`agt-postgres`, `agt-backups`) and images (Phase 10), the backup file name `agt-kb-backup-…` (Phase 6) and `localStorage` keys `agt-*` (Phase 8) do not follow NAME-2 | Predates the spec; renaming Compose variables and volumes needs the Phase 10 stack |
| AUTH-2, AUTH-3 | **To fix (Phase 4):** scrypt runs with default parameters and stores `scrypt$salt$hash`, not the fixed options and `scrypt$N$r$p$salt$hash` with a format check before any scrypt call; usernames are lower-cased and limited to 3–64 of `[a-z0-9_.-]` instead of stored as entered after trimming (1–64 code points) | Predates the spec; existing hashes need a rehash path. Passwords are already 12–1024 characters (the extra character-class rules tighten AUTH-3) |
| AUTH-5, AUTH-6, AUTH-8, AUTH-9 | **To fix (Phase 4):** setup is not at `/api/setup`, has no startup length check (SRV-8), and answers `403 SETUP_DISABLED` instead of `503 setup_password_missing`; the AUTH-6 reminders are incomplete; the Admin cookie is not `agt_knowledge_base_session` with `Path=/`, and its table is `admin_sessions`, not `sessions` | Predates the spec |
| AUTH-8, FE-3, SEC-5 | **To fix (Phase 4):** members use HMAC-signed bearer tokens (`LOCAL_AUTH_SECRET`) kept in `localStorage`, without CSRF headers, instead of the cookie sessions in the AUTH-1 row | Predates the spec; a security fix, so it may skip the deprecation period (VER-10) |
| SEC-1..SEC-4, SEC-6, API-9 | **To fix (Phase 4):** the API sends `Access-Control-Allow-*` headers when the deprecated `server.frontendOrigin` is set, and answers every `OPTIONS` request with `204`; no Content-Security-Policy, `X-Frame-Options`, `Referrer-Policy` or COOP; public reads send `Cache-Control: public, max-age=30`; the Compose web port is published on `0.0.0.0:8080` by default (the server itself defaults to `127.0.0.1:8081`); no `deploy/Caddyfile.example` or plain-HTTP warning | Predates the spec |
| SEC-7 | **To fix (Phase 4):** a hand-written rate limiter (`server/rate-limit.ts`), not `@fastify/rate-limit` with per-route limits and `429 rate_limited` bodies | Predates the spec |
| SEC-12, SEC-13 | **To fix (Phase 4):** Markdown is rendered by `MarkdownContent.tsx` with `rehype-sanitize`, not one `src/components/Markdown.tsx` with a remark plugin that turns raw HTML into text and an http/https-only `urlTransform`; external links and images do not yet follow SEC-12/SEC-13 attributes | Predates the spec |
| DATA-3, DATA-4, DATA-11 | **To fix (Phase 5):** migrations are inline SQL in `server/migrations.ts`, not `server/migrations/NNNN_*.sql`; a separate `migrate` job runs them instead of startup under the BAK-12 migration lock, and a newer schema does not stop the server (SRV-8); contract migrations wait for `MIGRATION_TARGET_ID`; `public` still holds the function `merge_preserved_orphan_tag_ids` (and the 006 triggers where 007 has not run); Compose connects as the `postgres` superuser and there is no `rolsuper` check or preview database | Predates the spec |
| DATA-6, DATA-8, DATA-10 | **To fix (Phase 5):** IDs come from `gen_random_uuid()` column defaults, not `crypto.randomUUID()`; not every table has `created_at` and `updated_at` (`app_users`, `articles` uses `modified_at`); persistent state is not all under one `/app/data` volume | Predates the spec |
| BAK-1..BAK-12, SEC-10 | **To fix (Phase 6):** backups are `/admin/backup` and `/admin/backup/restore`, with a `database.json` table dump and a 1.x manifest (`formatVersion: 2`, `migrations`, `files` object), not `pg_dump` with the BAK-2 manifest; no Postgres preview database with the TOC allowlist, operation lock with drain and `503 maintenance`, `control` schema, rollback or `restore-failed.json`; ZIP handling is not in `server/zip.ts` | Predates the spec |
| LOG-1..LOG-23, SRV-6 | **To fix (Phase 7):** the server logs with Fastify's pino logger to stdout only (scripts and a few services still use `console.*`), at a fixed `info` level; no `logs` schema, server log, audit log, retention, exports or the Server log / Audit log tabs | Predates the spec |
| STACK-2, FE-1, FE-2, FE-4, FE-5, FE-7, SRV-9 | **To fix (Phase 8):** `react-router-dom` with path routes (`/login`, `/articles/…`, `/tags`) instead of query-parameter deep links on `/`, so the server also answers those paths with `index.html`; `lucide-react` instead of `src/components/Icons.tsx`; no shared `apiRequest()`/`ApiError` in `src/lib/client.ts` with `x-agt-client: web`; no maintenance notice | Predates the spec |
| UI-1..UI-16 | **To fix (Phase 8):** own stylesheet and assets (`public/assets/agt-icon.png`, one font) instead of the spec's `assets/` copied unmodified with licence files and `src/agt-base.css` imported first; UI-7 public chrome and UI-8 admin tab order differ | Predates the spec |
| A11Y-1, A11Y-3..A11Y-6 | **To fix (Phase 8):** no shared `useDialog` hook outside MDXEditor, incomplete live regions, font scale not the 1×–2× `rem` scale, no axe checks | Predates the spec |
| I18N-1..I18N-6 | **To fix (Phase 9):** English only with hard-coded strings; no `src/translations.ts`, `src/admin/i18n.ts`, translated error codes or completeness tests | Predates the spec |
| DEP-1..DEP-10, SEC-15 | **To fix (Phase 10):** three Alpine images (Nginx `web`, `api`, `migrate`) on `node:26-alpine`, not one `node:26-bookworm-slim` image with healthcheck, `read_only`, `tmpfs` and `no-new-privileges`; no `deploy/` directory, systemd unit, local installation or Caddy example | Predates the spec |
| TEST-4, TEST-6..TEST-9 | **To fix (Phase 10):** no Playwright suite in `tests/e2e/` or CI job, no Postgres two-process tests, no release acceptance checklist | Predates the spec |
| DOC-1 | **To fix (Phase 10):** `README.md` lacks the AI disclosure line, Credits and the DOC-1 section order, and does not document local installation | Predates the spec |
| VER-11, VER-13 | **To fix (Phase 10; VER-11 at the next release):** the `v1.0.0` tag is on `648ee08`, whose `CHANGELOG.md` still says `Unreleased` (`main` dated the heading afterwards); the README installs and upgrades from a branch, not a release tag | Predates the spec |
