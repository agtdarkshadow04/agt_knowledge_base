# Agent guide — AGT Knowledge Base

AGT Knowledge Base is a TypeScript knowledge base for the Alliance of Galactic Travellers: a React 19 + Vite member
UI (`index.html` → `src/`) and a separate admin panel entry (`admin.html` → `src/admin/`), served by Nginx, with a
hand-written Node.js HTTP API (`backend/`) in front of PostgreSQL. There are two kinds of account. **Members**
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

Requires Node.js 22+ today (Node.js 26 is the target, see Deviations). Install with `npm ci`.

```bash
npm run lint        # ESLint, zero warnings allowed
npm run typecheck   # tsc -b over app and node projects
npm test            # Vitest, single run (~27 s, mostly jsdom)
npm run build       # typecheck + Vite production build
npm run api:dev     # run the API locally (needs PostgreSQL and .env)
npm run db:migrate  # apply migrations (only when explicitly asked; never against a real database otherwise)
```

Run a narrower check while iterating, then widen before finishing:

```bash
npx vitest run backend                    # backend tests only (~4 s)
npx vitest run path/to/file.test.ts       # one file; add -t "name" for one test
npx eslint path/to/file.ts                # lint only the files you touched
```

Before finishing, run lint, typecheck and the relevant tests; run the full suite and build for changes that cross the
frontend/backend boundary. No check needs a database, Docker or network access beyond `npm ci`. CI
(`.github/workflows/ci.yml`) runs lint, typecheck, test and build, and builds both Docker images, on pull requests and
pushes to `main`.

## Where things live

| Path | Purpose |
| --- | --- |
| `docs/agt-webapp-spec.md` | Pinned copy of the AGT Web Application Specification v6.0.0 (tag `v6.0.0`). Never edit; `.gitattributes` keeps it byte-identical |
| `CHANGELOG.md` | Release notes (Keep a Changelog 1.1.0), newest first (VER-9) |
| `backend/routes.ts` | Route table (`auth: 'none' \| 'member' \| 'admin'`, `rateLimit`) and the `ApiRequest`/`ApiResponse` types |
| `backend/server.ts` | HTTP pipeline: matching, rate limits, CSRF, member/Admin authentication, body limits, and the sign-in/setup/session/logout/password routes it serves itself |
| `backend/local-server.ts` | Startup: config, database pool, listen |
| `backend/config.ts` | `config.yaml` loading and its Zod schema (unknown keys are errors) |
| `backend/auth.ts` | `authenticate()`, the only place a member bearer token becomes a user; `requireActor` / `requireAdminSession` |
| `backend/admin-auth.ts` | Admin setup (`AGT_SETUP_PASSWORD`), sign-in and SHA-256-hashed cookie sessions |
| `backend/local-auth.ts` | Password hashing and signed member tokens |
| `backend/handler.ts`, `backend/admin-handler.ts` | Public/member and `/admin/*` route dispatch. The Admin handler never reads `request.actor` |
| `backend/*-service.ts` | Domain logic. `settings-service.ts` resolves config-file-wins settings; `backup-service.ts` + `backup-archive.ts` export, preview and restore ZIP backups |
| `backend/domain.ts` | Types, roles, visibility access rules, `AppError` classes |
| `backend/validation.ts` | Zod request parsing |
| `backend/repository.ts`, `backend/postgres-article-repository.ts` | Repository interfaces and all article/tag SQL (`admin-service.ts` holds the member-account SQL) |
| `backend/migrations.ts`, `backend/migrations-runner.ts`, `migrations/*.sql` | Inline migration SQL that actually runs, its runner, and reviewable SQL copies |
| `backend/rate-limit.ts`, `backend/db.ts`, `backend/line-diff.ts` | Rate limiter, `pg` pool, revision diff |
| `scripts/` | `migrate.ts` and the member-account recovery CLI `manage-local-user.ts` |
| `src/` | Member UI: `pages/`, `components/` (`MarkdownContent.tsx`, `RichMarkdownEditor.tsx`), `auth/`, `settings/`, `services/api.ts` (member API client), `types.ts`, `visibility.ts` (display options and colours) |
| `src/components/api-docs/` | OpenAPI renderer shared by both bundles |
| `src/admin/` | Admin panel: `AdminApp` (setup/login/dashboard), `*Panel.tsx` tabs, `api.ts`, `types.ts`. The member bundle must never import from `src/admin/` |
| `docs/API.md`, `docs/openapi.yaml`, `docs/openapi-admin.yaml` | API guide and the hand-written OpenAPI documents (public/member and `/admin/*`), rendered at `/api-docs` and in the admin API tab |
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
- Backend and scripts use `NodeNext` resolution, so relative imports **must** end in `.js`
  (`import { AppError } from './domain.js';`). Frontend imports under `src/` are extensionless.
- Validate request input in `backend/validation.ts`; signal domain failures with the `AppError` subclasses in
  `backend/domain.ts`, not ad-hoc errors.
- Keep SQL in `postgres-article-repository.ts` (or `admin-service.ts` for local users), always parameterized; map
  user-supplied sort fields through the existing allowlist.
- Keep changes minimal and consistent with existing patterns; a new runtime dependency needs a reason in the PR
  (STACK-1).
- **Tests:** colocated `*.test.ts(x)`. Frontend tests run in jsdom with Testing Library (`src/test/setup.ts`).
  Backend test files begin with `// @vitest-environment node` and use in-memory fakes; extend `MemoryRepository`
  (`backend/article-service.test.ts`) and `MemoryTagRepository` (`backend/tag-service.test.ts`) when a repository
  interface changes. Vitest runs with one worker and no file parallelism; keep it that way. Changes to role handling,
  protected-article rules, visibility, Markdown rendering, SQL construction or optimistic concurrency need regression
  tests (`SECURITY.md`). Never skip or weaken a test to make a change pass (TEST-5).
- **Adding or changing an API route:**
  1. `backend/routes.ts`: add it with `auth: 'member'`, `auth: 'admin'` (path must start with `/admin/`) or
     `auth: 'none'`. Every non-GET `/admin/*` request must carry `x-agt-request: 1` (`server.ts` enforces it). Add
     `rateLimit` for credential-checking routes.
  2. Member/public routes go in `backend/handler.ts` (roles via `requireActor` and the services); admin routes in
     `backend/admin-handler.ts`. `backend/routes.test.ts` fails if the table and the switches disagree. Routes that
     `server.ts` serves itself (sign-in, session, setup, logout, password) are listed in `serverRoutes` there.
  3. Client: `src/services/api.ts` + `src/types.ts` (member), `src/admin/api.ts` + `src/admin/types.ts` (admin).
  4. Docs: `docs/openapi.yaml` or `docs/openapi-admin.yaml` (security, parameters, body constraints from
     `validation.ts`, responses, `x-error-codes`, `x-required-role: Moderator`); `docs/API.md` for new concepts or
     error codes. `backend/openapi.test.ts` fails if routes, auth modes, rate limits or error codes and the docs
     disagree.
  5. Tests: `backend/handler.test.ts` / `backend/admin-handler.test.ts` (authorization), `backend/server.test.ts`
     (session separation, CSRF), `backend/routes.test.ts` (public routes).
- **Adding a database migration:** append the next `NNN_snake_case` entry to `migrations` in `backend/migrations.ts`
  (this inline SQL is what runs), add the matching `migrations/NNN_snake_case.sql` wrapped in `BEGIN;`/`COMMIT;`, and
  update `backend/migrations-runner.test.ts`. Never edit a shipped migration. Destructive (contract-phase) migrations
  set `requiresExplicitTarget: true`. Never schema-qualify objects (`public.`) or set `search_path`: backup restore
  replays migrations inside a staging schema; `migrations-runner.test.ts` checks this. Do not add functions, triggers,
  views or extensions (DATA-11).
- **Article visibility:** legacy text levels (`Public`, `Internal`, `Admin`) and AGT numeric levels (`0`–`5`) are both
  supported. Access rules live in `backend/domain.ts`, display options and colours in `src/visibility.ts`; keep them in
  sync and preserve legacy behaviour.
- **Authentication:** local accounts only; `AUTH_MODE` other than `local` stops the server. Handlers get the `Actor`
  on `request.actor` and never inspect tokens. `server.ts` verifies the Admin cookie for `auth: 'admin'` routes and
  passes `request.admin`. Bearer tokens are ignored on admin routes and the Admin cookie on member routes; never let
  one grant the other.
- **Configuration:** non-secret settings live in `config.yaml` (document every key in `config.example.yaml`); secrets
  stay in environment variables. Dashboard-editable keys resolve file → `application_settings` → default in
  `settings-service.ts`, and a key the file defines must never be changeable through any API, migration or restore.
- **Security (do not weaken, WF-4):** the API is the authorization boundary; UI hiding is never access control.
  Never commit `.env` files, secrets, database URLs or credentials; `VITE_*` values are public. Markdown is rendered
  without raw HTML and the API rejects HTML/JSX/MDX imports: never enable raw HTML or execute content as MDX, and
  never use `dangerouslySetInnerHTML` for user content. Updates, restores and deletes carry the article `version` and
  return `409` on mismatch. Server-owned fields (`created_at`, `created_by`, `modified_at`, `modified_by`, pinning,
  protection, version) are never accepted from clients, except by the Admin backup restore, which restores rows
  verbatim. No outbound requests from the server and no CDN assets in the client (SEC-14).
- **Backups:** a new table goes into `backupTables` in `backend/backup-service.ts` in foreign-key order. Only
  `admin_sessions` is listed in `unbackedTables`: never backed up, cleared by every restore. `config.yaml` is included
  in backups but never restored.
- The app has no anonymous writes (so no ALTCHA, §11), no file uploads other than backup archives (SEC-9), and shows
  no portal codes (UI-14).
- Update `README.md` when a change affects setup, configuration, roles/permissions or user-visible behaviour.
- Commit subjects are short and imperative (`Add AGT-standard visibility levels`), with `Refs #<issue>` in the body
  when working from an issue.

## Deviations from the AGT web app spec

Rule IDs refer to the pinned v6.0.0 copy. The first two rows are permanent and agreed in issue #48. Every row
marked **To fix** names the #48 phase that removes it; delete the row in that phase's PR.

| Rule | What differs | Why |
| --- | --- | --- |
| AUTH-1 | Besides the single Admin there are **member accounts** (`local_users`, roles `Editor` and `Moderator`). Consequences, all reusing the spec's own mechanisms: members sign in with AUTH-8 cookie sessions (cookie `agt_knowledge_base_member_session`, same attributes as the Admin cookie; table `member_sessions`; routes `/api/member/login`, `/api/member/logout`, `/api/member/session`), accepted only on member routes by one `onRequest` hook and never in place of the Admin cookie or the reverse; `x-agt-request: 1` on every member write (SEC-5); `rateLimits.login` with its own counter (SEC-7); AUTH-2/AUTH-3 password rules, with old member hashes rehashed on the next sign-in; a password reset, deactivation, role change or deletion by the Admin ends all of that member's sessions (AUTH-4); member sessions are never backed up and are emptied by a restore (BAK-2, BAK-4); OpenAPI adds the `memberSessionCookie` scheme (member reads `[{ memberSessionCookie: [] }]`, writes `[{ memberSessionCookie: [], csrfHeader: [] }]`, login `[{ csrfHeader: [] }]`), checked by the API-13 test (API-11); the audit log records `actor_type: member` with the username, and member 401/403 responses like admin ones (LOG-10, LOG-11) | Members writing and moderating articles are what the product is for. Nothing else is loosened. Until Phase 4 the member mechanism itself still deviates (see the AUTH-8 / FE-3 row) |
| STACK-3, UI-9, A11Y-2 | `@mdxeditor/editor` brings its own toolbar, select and link-dialog components (Radix-based) instead of `.button`/`.modal-*` classes and `useDialog` | Rich Markdown editing is a core feature, and no reasonable plain-React replacement exists. Limits: used only inside the article editor; styled with AGT tokens through its own CSS variables, never by overriding UI-9 classes; its popovers must still pass the TEST-6 checks (keyboard opening, Escape closes, focus returns, axe WCAG 2.2 AA) |
| NAME-1, §2.1 | **To fix (Phase 0):** the slug `knowledge-base` (AGT Knowledge Base, `agtdarkshadow04/agt_knowledge_base`, default port **8081**, PostgreSQL) is not in the spec's app registry yet | Needs a registry PR in the spec repository (SPEC-4) |
| STACK-1, STACK-7 | **To fix (Phase 1):** `engines` is `node >=22` without npm; TypeScript ~5.9, Vite 7, `@vitejs/plugin-react` 5, esbuild 0.25; no `allowScripts` decisions; extra dependencies (`zod`, `tsx`, `react-router-dom`, `lucide-react`, `rehype-sanitize`, ESLint, Vitest, jsdom, Testing Library) | Predates the spec |
| STACK-1, TEST-1, TEST-2, TEST-3 | **To fix (Phase 1):** lint is ESLint and tests are Vitest with jsdom, not `tsc -b` and `node:test`; no `npm run check` or the other TEST-1 scripts; CI runs on Node 22 | Predates the spec |
| STACK-1, REPO-1, SRV-1..SRV-8, SRV-10 | **To fix (Phase 1):** a hand-written HTTP pipeline in `backend/` (`server.ts`, `routes.ts`, `handler.ts`) instead of Fastify 5 + TypeBox in `server/` with `index.ts`, `buildApp()`, `context.ts`, `HttpError` and one error handler; esbuild bundles to `server/` rather than `dist-server/index.mjs` | Predates the spec |
| REPO-1, REPO-2, REPO-3, FE-6, FE-8 | **To fix (Phase 1):** layout uses `backend/`, `scripts/`, `migrations/*.sql` mirrored into `backend/migrations.ts`, `src/services/`, `src/pages/`; validation lives in `backend/validation.ts`, not a shared `src/lib/validation.ts` used by both server and forms; `.gitignore`/`.dockerignore` miss `dist-server/`, `.test-build/`, `test-results/`, `playwright-report/`, `data/` | Predates the spec |
| API-1, API-2, SRV-9, SRV-11 | **To fix (Phase 2):** routes have no `/api` prefix (Nginx strips it) and use `/admin/auth/login`, `/admin/backup/restore` and similar paths; Nginx, not the app, serves `dist/`; no `GET /api/health` | Predates the spec |
| API-5, API-6, API-8 | **To fix (Phase 2):** error bodies are `{ code: 'VALIDATION_ERROR', message, issues }` rather than snake_case `error` with `fields` and `params`; malformed IDs return `400`, not `404`; collections that can grow without bound use page/pageSize, not cursors | Predates the spec |
| API-3, API-10..API-14, VER-2 | **To fix (Phase 2):** OpenAPI is hand-written (`docs/openapi*.yaml`), not generated from TypeBox route schemas and served at `/api/openapi.json`; no `operationId`/`tags`/`security` per route or API-13 test; the in-app API docs are shown to members and visitors, not only to the signed-in Admin; `info.version` is not read from `package.json` | Predates the spec |
| CFG-1, CFG-3..CFG-10 | **To fix (Phase 3):** Zod config schema with non-standard keys (`server.frontendOrigin`, `adminSession.*`, `backup.maxBytes`, `rateLimits.adminLogin`/`adminPassword`, `site.applicationName`, …); `server.port` defaults to `3001`, not 8081; settings in `application_settings`, not `settings`; no `EDITABLE_SETTINGS`/`settingStates()`, `unknown_setting`/`invalid_setting`/`defined_in_config` codes or `GET /api/settings/public` | Predates the spec |
| CFG-2, NAME-2, DEP-4 | **To fix (Phase 3):** environment variables `LOCAL_AUTH_SECRET`, `AGT_SETUP_PASSWORD`, `DB_*`, `DATABASE_URL`, `DATABASE_SSL`, `POSTGRES_*`, `CONFIG_FILE`, `AUTH_MODE`, `MIGRATION_TARGET_ID`, `APP_*` instead of the CFG-2 set with the `AGT_KNOWLEDGE_BASE_` prefix; `docker.env.example` beside `.env.example`; npm package, volumes (`agt-postgres`, `agt-backups`), images, backup file name (`agt-kb-backup-…`) and `localStorage` keys (`agt-*`) do not follow NAME-2 | Predates the spec |
| AUTH-2, AUTH-3 | **To fix (Phase 4):** scrypt runs with default parameters and stores `scrypt$salt$hash`, not the fixed options and `scrypt$N$r$p$salt$hash` with a format check before any scrypt call; usernames are lower-cased and limited to 3–64 of `[a-z0-9_.-]` instead of stored as entered after trimming (1–64 code points) | Predates the spec; existing hashes need a rehash path. Passwords are already 12–1024 characters (the extra character-class rules tighten AUTH-3) |
| AUTH-5, AUTH-6, AUTH-8, AUTH-9 | **To fix (Phase 4):** setup is not at `/api/setup`, has no startup length check, and answers `403 SETUP_DISABLED` instead of `503 setup_password_missing`; the AUTH-6 reminders are incomplete; the Admin cookie is not `agt_knowledge_base_session` with `Path=/`, and its table is `admin_sessions`, not `sessions` | Predates the spec |
| AUTH-8, FE-3, SEC-5 | **To fix (Phase 4):** members use HMAC-signed bearer tokens (`LOCAL_AUTH_SECRET`) kept in `localStorage`, without CSRF headers, instead of the cookie sessions in the AUTH-1 row | Predates the spec; a security fix, so it may skip the deprecation period (VER-10) |
| SEC-1, SEC-2, SEC-3, SEC-4 | **To fix (Phase 4):** no Content-Security-Policy, `X-Frame-Options`, `Referrer-Policy` or COOP from the API or Nginx; the web port is published on `0.0.0.0:8080` by default; no `deploy/Caddyfile.example` or plain-HTTP warning | Predates the spec |
| SEC-7 | **To fix (Phase 4):** a hand-written rate limiter (`backend/rate-limit.ts`), not `@fastify/rate-limit` with per-route limits and `429 rate_limited` bodies | Predates the spec |
| SEC-12, SEC-13 | **To fix (Phase 4):** Markdown is rendered by `MarkdownContent.tsx` with `rehype-sanitize`, not one `src/components/Markdown.tsx` with a remark plugin that turns raw HTML into text and an http/https-only `urlTransform`; external links and images do not yet follow SEC-12/SEC-13 attributes | Predates the spec |
| DATA-3, DATA-4, DATA-11 | **To fix (Phase 5):** migrations are inline SQL in `backend/migrations.ts`, not `server/migrations/NNNN_*.sql`; a separate `migrate` job runs them instead of startup under the BAK-12 migration lock, and a newer schema does not stop the server; contract migrations wait for `MIGRATION_TARGET_ID`; `public` still holds the function `merge_preserved_orphan_tag_ids` (and the 006 triggers where 007 has not run); Compose connects as the `postgres` superuser and there is no `rolsuper` check or preview database | Predates the spec |
| DATA-6, DATA-8, DATA-10 | **To fix (Phase 5):** IDs come from `gen_random_uuid()` column defaults, not `crypto.randomUUID()`; not every table has `created_at` and `updated_at` (`app_users`, `articles` uses `modified_at`); persistent state is not all under one `/app/data` volume | Predates the spec |
| BAK-1..BAK-12, SEC-10 | **To fix (Phase 6):** backups are `/admin/backup` and `/admin/backup/restore`, with a `database.json` table dump and a 1.x manifest (`formatVersion: 2`, `migrations`, `files` object), not `pg_dump` with the BAK-2 manifest; no Postgres preview database with the TOC allowlist, operation lock with drain and `503 maintenance`, `control` schema, rollback or `restore-failed.json`; ZIP handling is not in `server/zip.ts` | Predates the spec |
| LOG-1..LOG-23, SRV-6 | **To fix (Phase 7):** logs go to `console.*` only; no pino, `logs` schema, server log, audit log, retention, exports or the Server log / Audit log tabs | Predates the spec |
| STACK-2, FE-1, FE-2, FE-4, FE-5, FE-7 | **To fix (Phase 8):** `react-router-dom` with path routes (`/login`, `/articles/…`, `/tags`, `/api-docs`) instead of query-parameter deep links on `/`; `lucide-react` instead of `src/components/Icons.tsx`; no shared `apiRequest()`/`ApiError` in `src/lib/client.ts` with `x-agt-client: web`; no maintenance notice | Predates the spec |
| UI-1..UI-16 | **To fix (Phase 8):** own stylesheet and assets (`public/assets/agt-icon.png`, one font) instead of the spec's `assets/` copied unmodified with licence files and `src/agt-base.css` imported first; UI-7 public chrome and UI-8 admin tab order differ | Predates the spec |
| A11Y-1, A11Y-3..A11Y-6 | **To fix (Phase 8):** no shared `useDialog` hook outside MDXEditor, incomplete live regions, font scale not the 1×–2× `rem` scale, no axe checks | Predates the spec |
| I18N-1..I18N-6 | **To fix (Phase 9):** English only with hard-coded strings; no `src/translations.ts`, `src/admin/i18n.ts`, translated error codes or completeness tests | Predates the spec |
| DEP-1..DEP-10, SEC-15 | **To fix (Phase 10):** three Alpine images (Nginx `web`, `api`, `migrate`) on `node:22`, not one `node:26-bookworm-slim` image with healthcheck, `read_only`, `tmpfs` and `no-new-privileges`; no `deploy/` directory, systemd unit, local installation or Caddy example | Predates the spec |
| TEST-4, TEST-6..TEST-9 | **To fix (Phase 10):** no Playwright suite in `tests/e2e/` or CI job, no Postgres two-process tests, no release acceptance checklist | Predates the spec |
| DOC-1 | **To fix (Phase 10):** `README.md` lacks the AI disclosure line, Credits and the DOC-1 section order, and does not document local installation | Predates the spec |
| VER-11, VER-13 | **To fix (Phase 10):** no release tags yet (the deployed `1.0.0` is untagged), and the README installs and upgrades from a branch, not a release tag | Predates the spec |
