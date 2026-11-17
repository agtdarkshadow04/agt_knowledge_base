# Agent guide — AGT Knowledge Base

AGT Knowledge Base is a TypeScript knowledge base for the Alliance of Galactic Travellers: a React 19 + Vite member
UI (`index.html` → `src/`) and a separate admin panel entry (`admin.html` → `src/admin/`), both served, with the REST
API under `/api/`, by a **Fastify 5** server (`server/`, Node.js 26, TypeScript) in front of PostgreSQL. The API is
described by an OpenAPI 3.1 document generated from its TypeBox route schemas (`GET /api/openapi.json`). There are two kinds of account. **Members**
(`local_users`, roles `Editor` and `Moderator`) sign in at `/login` with an HttpOnly cookie session (`member_sessions`).
The single installation **Admin** (the one-row `admin` table) signs in only at `/admin` with its own cookie session
(`sessions`), manages members,
settings and backups, and is never a member `Actor`. Moderators hold every content-moderation power (protection,
pinning, verification, restore, delete, tags, visibility levels 2–5 and legacy `Admin`). No cloud services: the
former AWS deployment has been removed, and no code, package or schema name may depend on AWS again.

**Database: PostgreSQL** (DATA-2), because many members edit at the same time: sustained concurrent writes from many
users, which also need Postgres full-text search and row-level optimistic concurrency control (`version` checks with
`409`). Users are keyed by `app_users.user_id` (migration `011` renamed it from `cognito_sub`; migrated Cognito
subjects keep their values). The server connects as the non-superuser role `agt_knowledge_base` and applies the
migrations itself at startup. Deployment: Docker Compose with one image (service `knowledge-base`, port 8081 on
loopback, volume `knowledge-base-data`) and `postgres:18` (service `db`, volume `knowledge-base-db`), or a systemd
service on Ubuntu/Debian (`deploy/agt-knowledge-base.service`); see `README.md`.

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
npm test            # test:client (src/lib/*.test.ts) + test:server (server/test/*.test.ts, needs the test database)
npm run test:e2e    # build, then the Playwright browser tests in tests/e2e/ against the real server (not part of check; needs Chromium and the test database)
npm run build       # Vite build → dist/, server bundle → dist-server/index.mjs
npm run dev:server  # build and run the API on 127.0.0.1:8081 (needs PostgreSQL 18 and the variables in .env.local; README, Local development)
npm run dev         # Vite dev server on :5173, proxies /api/ to :8081
```

Run a single test file:

```bash
npx esbuild server/test/routes.test.ts --bundle --platform=node --target=node26 --format=esm --packages=external --loader:.sql=text --outdir=.test-build/server --out-extension:.js=.mjs && node --test .test-build/server/routes.test.mjs
npx playwright test tests/e2e/editor.spec.ts -g "name"   # one browser test file, or one test (after npm run build)
```

The server tests and the browser tests need a PostgreSQL 18 server and a non-superuser role with `CREATEDB`, named by
`AGT_KNOWLEDGE_BASE_TEST_DATABASE_URL` (for example `postgres://agt_test:<password>@127.0.0.1:5432/postgres`; README,
Development): without it `npm run check` fails (TEST-3). Every server test database, and the browser tests'
`agt_knowledge_base_e2e`, is created through that role and dropped again. The backup tests also run `pg_dump` and
`pg_restore`, so the PostgreSQL client tools must be on the `PATH`. `npm run test:e2e` starts `node dist-server/index.mjs`
itself, on a fresh database, from first run (`tests/e2e/environment.ts`); it needs Chromium
(`npx playwright install --with-deps chromium`, or `PLAYWRIGHT_CHROMIUM_EXECUTABLE` pointing at an installed one).
CI (`.github/workflows/ci.yml`) runs `npm ci`, the install-script check (STACK-7) and `npm run check`, then
`npm run test:e2e`, each with a `postgres:18` service, and builds the image and starts the Compose stack until it is
healthy (TEST-8), on pull requests and pushes to `main`. Releases follow `docs/RELEASING.md` (VER-12, TEST-6..TEST-9).

## Where things live

| Path | Purpose |
| --- | --- |
| `docs/agt-webapp-spec.md` | Pinned copy of the AGT Web Application Specification v6.0.0 (tag `v6.0.0`). Never edit; `.gitattributes` keeps it byte-identical |
| `CHANGELOG.md` | Release notes (Keep a Changelog 1.1.0), newest first (VER-9) |
| `server/index.ts` | Entry point and the only server file that reads `process.env`: builds the `AppContext` from `loadStartup()`, logs deprecation warnings, listens, shuts down on SIGTERM/SIGINT |
| `server/startup.ts` | `loadStartup(env)`: the CFG-2 `AGT_KNOWLEDGE_BASE_*` variables (and their deprecated 1.x names), `config.yaml` loading and the database settings, for `server/index.ts` |
| `server/app.ts`, `server/headers.ts` | `buildApp(context, options)`: the Fastify app without `listen()` — route registration, the public reads (`createRequestHandler()`), the SEC-1..SEC-3 headers (their values in `headers.ts`), `@fastify/rate-limit` (SEC-7), body limits, the single error handler, and the sign-in/setup/session/logout/password routes it serves itself |
| `server/context.ts` | `AppContext` (config, config file text, database, setup password, version, operation lock, log store, tool path) and the settings precedence: `setting()`, `settingStates()`, `settingValues()`, `lockedSettingKeys()` (CFG-7) |
| `server/http.ts` | `HttpError(statusCode, error, message, { fields, params, legacyCode })` and `errorReply()`, the one mapping from errors to the API-6 error body |
| `server/routes.ts` | Route table: path under `/api/`, auth mode, `operationId`, tag, summary, TypeBox schemas, rate limit, and `replacedBy` for deprecated 1.x paths; the `ApiRequest`/`ApiResponse` types |
| `server/schemas.ts` | TypeBox request and response schemas of every route, `ErrorBody`/`FieldError`, and `errorCodes` (every code the server sends) |
| `server/openapi.ts` | `@fastify/swagger` registration and the `SECURITY` values each route declares (API-11) |
| `server/pagination.ts` | Opaque article-list cursors (API-8) |
| `server/config.ts` | `config.yaml`: its TypeBox schema with the CFG-5 keys (unknown keys are errors), the deprecated 1.x key names, and `EDITABLE_SETTINGS` (CFG-6) |
| `server/session.ts` | `AdminAuthService` (setup, sign-in, password change) and `MemberAuthService` (member sign-in) with their SHA-256-hashed cookie sessions (AUTH-3..AUTH-8), and the cookie helpers |
| `server/passwords.ts` | scrypt hashing with `SCRYPT_PROFILES`, the stored-hash format check (AUTH-2), `secretsEqual()` (AUTH-3) |
| `server/auth.ts` | `toActor`, `requireActor` / `requireAdminSession` |
| `server/adminRoutes.ts`, `server/memberRoutes.ts` | `authenticationHook`, the one `onRequest` hook that checks CSRF and the session cookies (AUTH-9, SEC-5), and the `/api/admin/*` dispatcher; `memberRoutes.ts` dispatches the member routes (AUTH-1 deviation). The public reads are in `createRequestHandler()` in `app.ts`, which passes everything else to the member routes. The Admin dispatcher never reads `request.actor` |
| `server/*-service.ts` | Domain logic, built with the context. `settings-service.ts` reads and writes the `settings` table (CFG-8) and the public settings |
| `server/backupCodes.ts` | The archive rejection reasons (`params.reason` of `archive_rejected`) and restore warning codes, without imports so the browser's translation tests can read them (I18N-6) |
| `server/backup.ts`, `server/zip.ts` | Backup and restore (§12): `BackupService` runs `pg_dump`/`pg_restore` as child processes (BAK-6), writes the BAK-2 archive, previews in the preview database with the table-of-contents allowlist (`allowlistToc`, `EXPECTED_TABLES`, BAK-3), restores with the pre-restore backup and rollback (BAK-4, BAK-10, BAK-11); `zip.ts` is the only ZIP reader and writer (SEC-10) |
| `server/operation.ts`, `server/dataWrite.ts` | The BAK-12 shared operation lock: `PostgresOperations` (control connection, startup, activity lease and admission, following, starting and finishing operations, owner failure, the `restore-failed.json` marker); `withDataWrite()` runs a `writesData` route under the shared write lock, and `assertDataWrite()` makes repository writes outside it throw (BAK-8) |
| `server/logs.ts`, `server/audit.ts` | The log store (§13): `LogStore` (server log entries buffered until the store is open, audit writes with LOG-11 coalescing, the LOG-12 IP hash, retention), `createLogger()` (pino multistream to stdout and the server log, LOG-5), `startRetention()` (LOG-15), streamed JSON Lines/CSV exports with formula neutralization (LOG-22); `audit.ts` is the one `onResponse` hook that writes every audit entry (LOG-11) and `writeSummary()` (LOG-14) |
| `server/domain.ts` | Types, visibility access rules, domain `HttpError` subclasses; re-exports the shared types from `src/lib/api.ts` |
| `server/db.ts` | `Database` (lazily created `pg.Pool`, which a restore closes; inside `withDataWrite()` its pool runs everything on the write's client, with repository transactions as savepoints), `withTransaction()`, `MIGRATIONS`, `CONTROL_MIGRATIONS`, `LOG_MIGRATIONS`, `migrateAtStartup()` (the BAK-12 startup steps: superuser check, migration lock, control schema, failed-restore check, log store, app migrations under the shared write lock) and `runMigrations()` |
| `server/repository.ts`, `server/repository/*.ts` | All SQL (SRV-4): the repository interfaces and `ping()`; `articles.ts` (articles, revisions, tags), `members.ts` (member accounts, statistics), `sessions.ts` (the Admin, sign-in, both session tables), `settings.ts`, `control.ts` (the `control.operation` row and the advisory locks), `backup.ts` (the preview database, restore checks and the step 6.1 commit), `logs.ts` (the `logs` schema) |
| `server/migrations/NNNN_<name>.sql`, `server/migrations/control/NNNN_<name>.sql`, `server/migrations/logs/NNNN_<name>.sql` | Every schema change, imported as text into `MIGRATIONS` (DATA-3); the `control` schema's migrations into `CONTROL_MIGRATIONS` (BAK-12) and the `logs` schema's into `LOG_MIGRATIONS` (LOG-1), which backups and restores never touch |
| `server/rate-limit.ts`, `server/line-diff.ts` | The shared store behind `@fastify/rate-limit` (keyed by `request.ip`, which honours `server.trustProxy`, plus the route's bucket), revision diff |
| `server/test/` | `node:test` server tests; `helpers.ts` has `testContext()`, `fakeDatabase()`, `testOperations()`, `testLogs()`, `dataWriteIt()`, `assertMatches()`, `rejectsMatching()`, `match.*`, `respond()`; `postgres.ts` has `createTestServer()` and `createTestDatabase()` for the real-PostgreSQL tests in `postgres.test.ts` (TEST-3, TEST-4: startup, backups, the BAK-3 allowlist on real dumps, and two processes on one database) |
| `src/lib/` | Framework-free code, shared with the server where it needs it (REPO-3, FE-8): `validation.ts` (Zod request parsing, and `validate()` for forms (FE-6); change rules here only), `api.ts` (API types and roles), `errors.ts` (`FieldError`, field codes, Zod issues → field errors), `client.ts` (`apiRequest()`/`ApiError`, the only way the browser calls the API, FE-2), `memberApi.ts` (the member UI's calls), `routes.ts` (query-parameter deep links, FE-4), `preferences.ts` (the one `agt_knowledge_base_settings` `localStorage` object: language, time zone, font scale and the article preferences, FE-3, I18N-4), `format.ts` (`Intl` date, number and size formatting in the reader's language and time zone, I18N-5), `translationChecks.ts` (the completeness checks the translation tests share), `markdown.ts` (the URL allowlist, raw HTML as text and heading ids of `Markdown.tsx`, SEC-12), `tags.ts` (tag colours), `visibility.ts` (visibility keys and colours; labels are in the string tables), `editorTranslation.ts`, `openapi.ts` (reads the OpenAPI document for the admin API tab), with `node:test` tests in `*.test.ts` |
| `deploy/` | `agt-knowledge-base.service` (the systemd unit, DEP-7), `Caddyfile.example` (DEP-10) and `postgres-init/10-app-role.sh` (the database role and databases on a new `db` volume, DEP-3) |
| `src/` | Member UI: `main.tsx`, `App.tsx` (picks the page from the query string), `translations.ts` (`LOCALES` and the member UI's string tables for all 10 locales, I18N-1..I18N-3), `agt-base.css` (the AGT base stylesheet, copied unmodified, UI-16), `styles.css` (imports it first); `components/`: the pages, `Layout.tsx` (UI-7 chrome), `Navigation.tsx` (history and links without a router, STACK-2), `I18n.tsx` (`I18nProvider`/`useI18n`: the reader's language, string table, time zone and formatters for both entries; sets `<html lang>` and the `data-*` preference attributes), `Dialog.tsx` and `useDialog.ts` (every dialog, A11Y-2), `Field.tsx` (labelled fields with errors, A11Y-5), `Icons.tsx` (FE-7), `MaintenanceNotice.tsx` (FE-5), `Markdown.tsx` (the one Markdown renderer, SEC-12), `RichMarkdownEditor.tsx`; the browser tests in `tests/e2e/` cover them |
| `src/admin/` | Admin panel: `AdminApp` (UI-8 shell, setup/login/dashboard, the tablist, the preferences dialog), `i18n.ts` (the admin string tables for all 10 locales), `context.ts` (`useAdminI18n()`), `*Panel.tsx` tabs (`ServerLogPanel.tsx`/`AuditLogPanel.tsx` over `LogPanel.tsx`; `ApiPanel.tsx` + `api-docs/` render `/api/openapi.json`, API-14), `admin.css` (imported after `src/styles.css`), `api.ts`, `types.ts`. The member bundle must never import from `src/admin/` |
| `public/` | The AGT logo, NMS Futura, the flag font and the font licences, copied unmodified from the spec's v6.0.0 `assets/` and checked by SHA-256 in `server/test/assets.test.ts` (UI-15); the server serves them at their own paths |
| `tests/e2e/`, `playwright.config.ts` | Playwright browser tests (TEST-6) against `node dist-server/index.mjs` on a fresh database: `environment.ts` (the database, `config.yaml` and setup password), `setup.spec.ts` (the setup project: first-run setup, the members and the sample content, saving the signed-in states in `.auth/`), `fixtures.ts` (axe, dialog and layout checks), and one spec per area; `quality.spec.ts` runs axe WCAG 2.2 AA on every page, the UI-12 widths, the 2× text size, the dialogs and the CSP |
| `docs/RELEASING.md` | The release PR and the acceptance checks: TEST-7 checklist, TEST-8 installation runs, TEST-9 upgrade and rollback |
| `docs/API.md` | API guide: authentication, deprecated paths, pagination, error codes (every code in `errorCodes` must be listed) |
| `config.example.yaml` | Every `config.yaml` key with its default |
| `Dockerfile`, `docker-compose.yml`, `.env.example`, `.env.db.example` | The DEP-1 image (`node:26-bookworm-slim`, PGDG `postgresql-client-18`, healthcheck), the DEP-2/DEP-3 Compose stack (`knowledge-base` and `db`), and the secrets templates (DEP-4; `.env.db` holds only the database superuser's password) |
| `.github/workflows/ci.yml` | CI |

## Conventions and gotchas

- **Versioning (§21):** every PR that ships changes (code, assets, migrations, `Dockerfile`, `docker-compose.yml`,
  `config.example.yaml`, `deploy/`) bumps the version with `npm version X.Y.Z --no-git-tag-version` and adds its
  entries under `## [X.Y.Z] - Unreleased` in `CHANGELOG.md`; the PR description states the level and rule (VER-8,
  VER-9). Docs-only, test-only, CI and `AGENTS.md` changes need no bump (VER-6). Removing or renaming a config key,
  environment variable, route, parameter or field needs a deprecation in an earlier minor release first (VER-10).
  Create tags and GitHub Releases only when the maintainer asks (VER-12).
- **Spec work:** cite rule IDs in commits and PRs (WF-2). When a PR makes a deviation below go away, delete its row in
  the same PR; when it adds one, add a row. One concern per PR (WF-3); the #48 phases are one PR each.
- TypeScript `strict`, ES modules. No Prettier: match the surrounding style (2-space indent, single quotes,
  semicolons, trailing commas).
- TypeScript is `strict` with `noUnusedLocals`, `noUnusedParameters` and `noFallthroughCasesInSwitch`; lint fails on
  unused symbols. Server files import relative files with a `.js` extension
  (`import { HttpError } from './http.js';`); frontend imports under `src/` are extensionless, and files in `src/lib/`
  that the server imports use `.js` too.
- **Server structure (SRV-1..SRV-3):** only the entry point (`server/index.ts`) reads `process.env`,
  and it passes it to `loadStartup()` in `server/startup.ts`, which alone interprets variables and decides where the
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
- Keep SQL in `server/repository/*.ts` (SRV-4; only the migration runner in `db.ts` has its own), always
  parameterized; map user-supplied sort fields through the existing allowlist. New rows get `crypto.randomUUID()` IDs
  from the server, never a column default (DATA-6); validate incoming IDs with `isUuidV4()` from `src/lib/api.ts`.
  Wrap multi-statement writes in `withTransaction()`.
- **Data writes (BAK-8, BAK-12):** every route declares `writesData` in `server/routes.ts` (true when it changes the
  main database; session rows alone do not count), and `app.ts` runs those routes in `withDataWrite()` and computes
  the response before sending it, so the transaction commits first. Every repository function that writes the main
  database calls `assertDataWrite()` first; repository tests use `dataWriteIt()`. `server/test/server.test.ts` checks the declarations.
- **Logging (§13):** log through the pino logger (`app.log`, `request.log`, or the logger `server/index.ts` builds)
  with a `source` (`startup`, `shutdown`, `config`, `migrations`, `retention`, `backup`, `http`, `auth`,
  `security`); never `console.*` in the server. Never log passwords, tokens, cookies, keys, request bodies or raw IPs
  (SRV-6, LOG-9). Never audit by hand: the `onResponse` hook in `server/audit.ts` audits every non-GET route, GET routes
  with `audit: true` in `server/routes.ts` (downloads, exports), admin 401/403s and every 429. A handler adds the target
  and a summary by returning `audit` on its `ApiResponse` (or setting `request.audit` in `app.ts`); summaries name
  things and list changed field names, never values or bodies (LOG-14). Log tables are append-only: only retention
  and the Admin's Clear (server log only) delete entries, and no route may edit or delete audit entries (LOG-2,
  LOG-18). Log store writes never join a data write and never fail a request (LOG-3).
- Keep changes minimal and consistent with existing patterns; a new runtime dependency needs a reason in the PR
  (STACK-1).
- **Tests:** server tests live in `server/test/*.test.ts` and `src/lib` tests next to their file; both use `node:test`
  and `node:assert/strict`, are bundled by esbuild into `.test-build/`, and read repository files by paths relative to
  the repository root (never `import.meta.url`). Build test contexts with `testContext()` and fake databases with
  `fakeDatabase()` from `server/test/helpers.ts`; use `mock.fn()` for spies, `assertMatches()` / `rejectsMatching()`
  for partial matches (same rules as Vitest's `toMatchObject`), and `buildApp()` with `inject()` or `listen({ port: 0 })`
  for HTTP; what needs real PostgreSQL (backups, locks, two processes) uses `createTestServer()` from
  `server/test/postgres.ts`, with test hooks (`hooks.afterStateUpdate`, `pauseFollowing()`, `dropControlConnection()`,
  a dispatcher that holds a request) instead of sleeps. Extend `MemoryRepository` (`server/test/article-service.test.ts`) and `MemoryTagRepository`
  (`server/test/tag-service.test.ts`) when a repository interface changes. There are no component tests: UI behaviour
  is tested in the browser (`tests/e2e/`, one worker, signed-in states from the setup project, a fresh article per test
  that changes one; `page.route` only for states the server cannot produce on demand), and UI logic that needs no DOM
  goes in `src/lib/` with a `node:test` test. A UI change runs `npm run test:e2e`. Changes to role handling,
  protected-article rules, visibility, Markdown rendering, SQL construction or optimistic concurrency need regression
  tests (`SECURITY.md`). Never skip or weaken a test to make a change pass (TEST-5).
- **Adding or changing an API route:**
  1. `server/routes.ts`: add it under `/api/` with `auth: 'member'`, `auth: 'admin'` (path must start with
     `/api/admin/`) or `auth: 'none'`, `writesData` (BAK-8), a unique camelCase `operationId`, a tag, a one-sentence summary, and TypeBox
     schemas (`server/schemas.ts`) for its params, query string, body and success response. `buildApp()` registers
     every table entry on Fastify with the matching `security` (API-11). Every non-GET request to `/api/admin/*`,
     `/api/setup` and the member routes must carry `x-agt-request: 1` (`authenticationHook` enforces it). Add `rateLimit`
     for credential-checking routes. Renaming a route keeps the old path as an entry with `replacedBy` until the next
     major version (VER-10).
  2. Member routes go in `server/memberRoutes.ts` (roles via `requireActor` and the services), public reads in
     `createRequestHandler()` in `server/app.ts`; admin routes in
     `server/adminRoutes.ts`. `server/test/routes.test.ts` fails if the table and the switches disagree. Routes that
     `app.ts` serves itself (sign-in, session, setup, logout, password) are listed in `serverRoutes` there.
  3. Client: `src/lib/memberApi.ts` + `src/lib/api.ts` (member), `src/admin/api.ts` + `src/admin/types.ts` (admin), both through `apiRequest()`.
  4. Docs: the OpenAPI document is generated; `server/test/openapi.test.ts` (API-13) fails if a route is missing or
     incomplete, its security is wrong, or an error code is missing from `errorCodes` or `docs/API.md`. Update
     `docs/API.md` for new concepts.
  5. Tests in `server/test/`: `memberRoutes.test.ts` / `adminRoutes.test.ts` (authorization), `server.test.ts` (session
     separation, CSRF, cookies, body and rate limits), `routes.test.ts` (routing and auth modes).
- **Adding a database migration:** add `server/migrations/NNNN_<snake_case>.sql` (the next number; no
  `BEGIN`/`COMMIT`, the runner wraps each migration in a transaction) and import and append it to `MIGRATIONS` in
  `server/db.ts`; `server/test/db.test.ts` fails if the list and the files disagree. Never edit or reorder a shipped
  migration. The server applies it at startup, so a migration must be safe while no older process runs. Never
  schema-qualify objects (`public.`) or set `search_path` (DATA-11). A restore migrates an older backup after
  `pg_restore`, so every migration must also run on data restored from any earlier 2.x backup.
  Do not add functions, triggers, views or extensions (DATA-11), and use `text`, `timestamptz` and `uuid`; every new
  table gets `created_at` and `updated_at` unless it is a pure join or log table (DATA-8).
- **Article visibility:** legacy text levels (`Public`, `Internal`, `Admin`) and AGT numeric levels (`0`–`5`) are both
  supported. Access rules live in `server/domain.ts`, display options and colours in `src/lib/visibility.ts`; keep them in
  sync and preserve legacy behaviour.
- **Authentication:** local accounts only; `AUTH_MODE` other than `local` stops the server. Handlers get the `Actor`
  on `request.actor` and never inspect cookies. `authenticationHook` (`server/adminRoutes.ts`) verifies the Admin
  cookie on `auth: 'admin'` routes (`request.admin`) and the member cookie on `auth: 'member'` routes
  (`request.member`); the member cookie is ignored on admin routes and the Admin cookie on member routes, and no bearer
  token is accepted anywhere: never let one grant the other. Store passwords only through `server/passwords.ts`; a new
  scrypt profile needs the rehash-on-sign-in code with it (AUTH-2). Anything that ends a member's access (password
  reset, deactivation, role change, deletion) deletes their `member_sessions` rows (AUTH-4).
- **Security headers (SEC-1..SEC-3):** the first `onRequest` hook in `app.ts` sets the exact CSP and the other headers
  on every response. Never widen the CSP, never add CORS (SEC-6), and render stored Markdown only through
  `src/components/Markdown.tsx` (SEC-12).
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
- **Backups:** a new table goes into `EXPECTED_TABLES` in `server/backup.ts`, or the BAK-3 allowlist rejects every
  backup that has it; a migration that drops a table must keep older backups restorable. Only `sessions` and
  `member_sessions` are in `sessionTables`: their rows are never dumped (`--exclude-table-data`) and every restore
  empties them. `config.yaml` is included in backups but never restored (BAK-5). Never let a dump restore anything
  the allowlist does not keep, and never point `database.previewName` at the app's database (startup refuses it).
- The app has no anonymous writes (so no ALTCHA, §11), no file uploads other than backup archives (SEC-9, BAK-1:
  multipart, streamed to a temporary directory under `backupsDir` that is always deleted), and shows
  no portal codes (UI-14).
- **Frontend (§14–§16):** call the API only through `apiRequest()`/`apiFetch()` in `src/lib/client.ts`; no router
  (a new page is a `Route` in `src/lib/routes.ts` and a case in `src/App.tsx`, linked with `Link` from
  `components/Navigation.tsx`); icons only from `components/Icons.tsx`; every dialog through `Dialog`/`ConfirmDialog`
  (`useDialog`), never `window.confirm`; form fields through `components/Field.tsx`, checked with `validate()` and the
  parser the server uses; status changes in a `role="status"` live region; `localStorage` only through
  `src/lib/preferences.ts`. CSS adds to `src/agt-base.css` and never edits it, redefines its tokens or restyles a UI-9
  class (`server/test/assets.test.ts`); sizes text in `rem`. Admin-only rules go in `src/admin/admin.css`.
- **Translations (§17):** every string the UI shows comes from `src/translations.ts` (member UI, `useI18n().t`) or
  `src/admin/i18n.ts` (admin UI, `useAdminI18n()` from `src/admin/context.ts`), never from a literal in a component;
  `src/lib/translations.test.ts` scans the components for hard-coded text. A new string goes into the English table
  and into all nine other locales in the same PR, with the same `{{placeholders}}` (`formatTranslation()`); the
  completeness tests fail on a missing key, a changed placeholder or an untranslated English sentence. A new error
  code or field code needs a string in `errors`/`fieldErrors`, a new field name in `fields`, a new archive rejection
  reason or restore warning in `server/backupCodes.ts` and the admin `backup.reasons`/`warnings`. Show errors with
  `useI18n().error()` (`errorText()`), never with the API's English `message`. Format dates, numbers and sizes only
  through `useI18n()` (`src/lib/format.ts`), never with `toLocaleString()` or a fixed locale. Article content and
  API `message` texts stay English.
- Update `README.md` when a change affects setup, configuration, roles/permissions or user-visible behaviour.
- Commit subjects are short and imperative (`Add AGT-standard visibility levels`), with `Refs #<issue>` in the body
  when working from an issue.

## Deviations from the AGT web app spec

Rule IDs refer to the pinned v6.0.0 copy. The first two rows are permanent and agreed in issue #48. Every row
marked **To fix** names the #48 phase, or the major release, that removes it; delete the row in that PR.

| Rule | What differs | Why |
| --- | --- | --- |
| AUTH-1 | Besides the single Admin there are **member accounts** (`local_users`, roles `Editor` and `Moderator`). Consequences, all reusing the spec's own mechanisms: members sign in with AUTH-8 cookie sessions (cookie `agt_knowledge_base_member_session`, same attributes as the Admin cookie; table `member_sessions`; routes `/api/member/login`, `/api/member/logout`, `/api/member/session`), accepted only on member routes by one `onRequest` hook and never in place of the Admin cookie or the reverse; `x-agt-request: 1` on every member write (SEC-5); `rateLimits.login` with its own counter (SEC-7); AUTH-2/AUTH-3 password rules, with old member hashes rehashed on the next sign-in; a password reset, deactivation, role change or deletion by the Admin ends all of that member's sessions (AUTH-4); member sessions are never backed up and are emptied by a restore (BAK-2, BAK-4); OpenAPI adds the `memberSessionCookie` scheme (member reads `[{ memberSessionCookie: [] }]`, writes `[{ memberSessionCookie: [], csrfHeader: [] }]`, login `[{ csrfHeader: [] }]`), checked by the API-13 test (API-11); the audit log records `actor_type: member` with the username, and member 401/403 responses like admin ones (LOG-10, LOG-11) | Members writing and moderating articles are what the product is for. Nothing else is loosened. Implemented in `server/session.ts` (`MemberAuthService`), the `authenticationHook` in `server/adminRoutes.ts`, and the member routes in `server/memberRoutes.ts`, beside `adminRoutes.ts` (REPO-1) |
| STACK-3, UI-9, A11Y-2 | `@mdxeditor/editor` brings its own toolbar, select and link-dialog components (Radix-based) instead of `.button`/`.modal-*` classes and `useDialog`. Opening its block-type select makes Radix add a scroll-lock `<style>` element, which the CSP blocks (`style-src-elem`): the select works, but the page keeps scrolling while it is open. Its select keeps focus from returning to the trigger on close; `RichMarkdownEditor.tsx` puts it back after Escape | Rich Markdown editing is a core feature, and no reasonable plain-React replacement exists. Limits: used only inside the article editor; styled with AGT tokens through its own CSS variables and public classes (`styles.css`), never by overriding UI-9 classes; its strings go through its `translation` prop; its popovers must still pass the TEST-6 checks (keyboard opening, Escape closes, focus returns, axe WCAG 2.2 AA). `tests/e2e/editor.spec.ts` checks the CSP behaviour (#48 §2) and the select's focus, and `quality.spec.ts` runs axe on the editor page |
| NAME-1, §2.1 | **To fix (Phase 0):** the slug `knowledge-base` (AGT Knowledge Base, `agtdarkshadow04/agt_knowledge_base`, default port **8081**, PostgreSQL) is not in the spec's app registry yet | Needs a registry PR in the spec repository (SPEC-4) |
| SRV-9, API-1, API-2, API-3, API-6, API-8 | **To fix (3.0.0):** the member UI's 1.x page paths (`/login`, `/tags`, `/articles/…`) redirect (`301`) to their query-parameter addresses (SRV-9 serves only `/` and `/admin`); the 1.x paths `/api/admin/setup/status`, `/api/admin/setup`, `/api/admin/auth/login`, `/logout`, `/session` and `PUT /api/admin/auth/password` still work next to their API-1 replacements; error bodies still carry the 1.x `code` and `issues` beside `error`/`fields`; article lists still accept `page`/`pageSize` and then return `page`, `pageSize`, `totalPages`; admin user create/replace return the user, not `{ user, notices }`, a member's password is set with `PUT …/password`, not an action `POST`, and article flags change with `PATCH …/protection`, `/pinning`, `/verification`; public article responses use the member schema, which includes the `createdBy`/`modifiedBy` user IDs; `GET /api/settings` and the 1.x `version`/`settings` fields of `/api/admin/settings` still work next to `GET /api/settings/public`, `states` and `values`; `POST /api/admin/backup/restore?action=` (the raw ZIP body) still works next to the multipart `POST /api/admin/restore`, and restore previews and reports still carry `migrations` beside `schemaVersion`. CFG-2, CFG-5: the 1.x `config.yaml` keys (`site.applicationName`, `site.applicationSubtitle`, `backup.maxBytes`, `adminSession.*`, `rateLimits.adminLogin`/`adminPassword`, `server.frontendOrigin`) and environment variables (`AGT_SETUP_PASSWORD`, `CONFIG_FILE`, `DB_*`, `DATABASE_URL`, `DATABASE_SSL`, `LOCAL_USER_PASSWORD`, `AUTH_MODE`) are still read, with a startup warning, AUTH-5, AUTH-6: `GET /api/setup/status` still returns `required` and the Admin session `setupPasswordSet` beside `adminExists` and `setupPasswordStillSet`; the deprecated `server.frontendOrigin` still marks session cookies `Secure` under `auto`, and `server.trustProxy` still accepts the 1.x number of proxy hops (CFG-5, CFG-6). AUTH-2: besides the spec's profile, `SCRYPT_PROFILES` accepts the 1.x profile (`N = 16384`, input not NFKC-normalized) that migration 017 converted 1.x hashes to, and rehashes it at the next sign-in | Each is a rename or removal that VER-10 lets a major version make only after a deprecation period; all are deprecated in 2.0.0 (`deprecated: true` in OpenAPI, startup warnings, `CHANGELOG.md`). The 1.x hash profile can go once every account has signed in since 2.0.0 or had its password reset |
| TEST-4 | **To fix (Phase 10b follow-up):** `server/test/postgres.test.ts` covers most of TEST-4's Postgres list (startup, backups, the BAK-3 allowlist on real dumps, two processes: writes waiting, maintenance, admission, connection loss, owner failure, late starters); these items are still covered only by the fake-database tests or not yet: the recovery restore and recovery admission (BAK-11) on real PostgreSQL, also from another process; the BAK-10 rollback-list test; a second preview at the same time (`409`), a preview paused while a process starts, and the after-restore preview rejections (newer schema, missing table, bad admin hash); dumps with an extension or an event trigger; a backup that includes a write already in progress, a write held past 30 seconds (`409`), a follower paused with a write in progress; and a restore waiting for a held read, a job and a download | Needs more test hooks in `BackupService`; the rest of TEST-4 is met |
| DOC-1 | **To fix (Phase 10):** `README.md` lacks the AI disclosure line and the DOC-1 section order, and does not document local installation | Predates the spec |
| VER-11, VER-13 | **To fix (Phase 10; VER-11 at the next release):** the `v1.0.0` tag is on `648ee08`, whose `CHANGELOG.md` still says `Unreleased` (`main` dated the heading afterwards); the README installs and upgrades from a branch, not a release tag | Predates the spec |
