# AGENTS.md

Guidance for AI coding agents working in this repository. Human-facing setup and deployment instructions live in `README.md`; security expectations live in `SECURITY.md`. Read both before making non-trivial changes.

## Project overview

AGT Knowledge Base is a TypeScript knowledge base for the Alliance of Galactic Travellers: a React 19 + Vite frontend, a Node.js API, and PostgreSQL. It is self-hosted with Docker: Nginx → Node.js API (`backend/local-server.ts`) → PostgreSQL, with local username/password auth.

There are two kinds of account. **Members** (`local_users`, roles `Editor` and `Moderator`) sign in at `/login` with bearer tokens. The single installation **Admin** (the one-row `admin` table) signs in only at `/admin` with an HttpOnly cookie session (`admin_sessions`), manages members, settings, and backups, and is never a member `Actor`. Moderators hold every content-moderation power (protection, pinning, verification, restore, delete, tags, visibility levels 2–5 and legacy `Admin`).

The former AWS deployment (Amplify Hosting, API Gateway, Lambda, RDS, Cognito) has been removed from this branch: no code, packages, or schema names depend on AWS. Do not add AWS dependencies. Users are keyed by `app_users.user_id`; migration `011_rename_user_key` renamed it from `cognito_sub`, and existing Cognito subjects keep their values so migrated authorship stays intact. Migration `012_admin_account` moved the former super administrator into `admin` and renamed roles (`Admin` → `Moderator`, `Standard` → `Editor`).

## Branches

- `main` is the default branch. Base work on it unless told otherwise.
- `staging` is frozen: AWS Amplify builds the existing AWS test deployment from it. Never push to, merge into, rebase, or delete `staging`.

## Repository layout

```text
src/              Member React UI (index.html → src/main.tsx): pages/, components/, auth/,
                  settings/, services/api.ts (member API client),
                  components/api-docs/ (OpenAPI renderer shared by both bundles)
src/admin/        Admin panel, a separate Vite entry (admin.html → src/admin/main.tsx):
                  AdminApp (setup/login/dashboard), *Panel.tsx tabs, api.ts (admin client).
                  The member bundle must never import from src/admin/.
backend/          API: routes.ts (route table + ApiRequest/ApiResponse types),
                  server.ts (HTTP pipeline: matching, rate limits, CSRF, member/Admin
                  authentication, body limits, sign-in/setup routes), local-server.ts (startup),
                  config.ts (config.yaml loading and Zod schema), rate-limit.ts,
                  auth.ts (member token-to-user step, requireActor/requireAdminSession),
                  admin-auth.ts (Admin setup, sign-in, cookie sessions),
                  local-auth.ts (password hashing, signed member tokens), db.ts (pg pool),
                  handler.ts (public/member route dispatch), admin-handler.ts (admin route dispatch),
                  *-service.ts (domain logic; settings-service.ts resolves config-file-wins
                  settings; backup-service.ts + backup-archive.ts export/preview/restore ZIP
                  backups), domain.ts (types, roles, visibility, AppError classes),
                  validation.ts (Zod request parsing), repository.ts (interfaces),
                  postgres-article-repository.ts (SQL), migrations.ts + migrations-runner.ts
migrations/       Reviewable SQL copies of each migration
docs/             API.md (API guide), openapi.yaml (public/member routes),
                  openapi-admin.yaml (/admin/* routes), rendered at /api-docs and the admin API tab
scripts/          migrate, member-account recovery CLI
config.example.yaml  Every config.yaml key with its default
.github/          CI workflow
```

## Commands

Requires Node.js 22+. Install with `npm ci`.

```bash
npm run lint        # ESLint, zero warnings allowed
npm run typecheck   # tsc -b over app and node projects
npm test            # Vitest, single run
npm run build       # typecheck + Vite production build
```

CI (`.github/workflows/ci.yml`) runs lint, typecheck, test, and build, and builds both Docker images, on pull requests and pushes to `main`.

Use the narrowest check that covers your change while iterating, then widen before finishing:

```bash
npx vitest run backend                    # backend tests only (~4s; full suite ~27s, mostly jsdom)
npx vitest run path/to/file.test.ts       # one file; add -t "name" for one test
npx eslint path/to/file.ts                # lint only the files you touched
```

Before finishing, run lint, typecheck, and the relevant tests; run the full suite and build for changes that cross the frontend/backend boundary. Do not run migrations against a real database unless explicitly asked. No check needs a database, Docker, or network access beyond `npm ci`.

## Code conventions

- TypeScript `strict`, ES modules. No Prettier is configured: match the surrounding style (2-space indent, single quotes, semicolons, trailing commas).
- Backend and scripts use `NodeNext` resolution, so relative imports **must** end in `.js` (e.g. `import { AppError } from './domain.js';`). Frontend imports under `src/` are extensionless.
- Validate request input in `backend/validation.ts` with Zod; signal domain failures with the `AppError` subclasses in `backend/domain.ts` rather than ad-hoc errors.
- Keep SQL in `postgres-article-repository.ts` (or `admin-service.ts` for local users) and always parameterize values; map user-supplied sort fields through the existing allowlist.
- Keep changes minimal and consistent with existing patterns; do not add dependencies without a clear need.

## Tests

- Tests are colocated as `*.test.ts` / `*.test.tsx` next to the code they cover.
- Frontend tests run in jsdom with Testing Library (`src/test/setup.ts`). Backend test files begin with `// @vitest-environment node` and use in-memory fakes of the repository interfaces rather than a real database. Extend the existing fakes (`MemoryRepository` in `backend/article-service.test.ts`, `MemoryTagRepository` in `backend/tag-service.test.ts`) when a repository interface changes, rather than writing new ones.
- Vitest runs with a single worker and no file parallelism; do not change that to speed up runs.
- Per `SECURITY.md`, changes to role handling, protected-article rules, visibility, Markdown rendering, SQL construction, or optimistic concurrency must include regression tests.

## Cross-cutting change checklists

**Adding or changing an API route:**

1. `backend/routes.ts` — add the route to the table with `auth: 'member'` (bearer token), `auth: 'admin'` (Admin cookie session; path must start with `/admin/`), or `auth: 'none'` for public reads. Every non-GET `/admin/*` request must carry `x-agt-request: 1`; `server.ts` enforces this. Add `rateLimit` for credential-checking routes.
2. Member/public routes: add the `case` to `backend/handler.ts`, enforcing roles with `requireActor` and the services' role checks. Admin routes: add it to `backend/admin-handler.ts`, which never reads `request.actor`. `backend/routes.test.ts` fails if the table and the switches disagree. The exceptions are the member and Admin sign-in, session, setup, logout, and password routes, which `server.ts` serves itself; they are listed in `serverRoutes` in `backend/routes.test.ts`, so a new server-served route must be added there too.
3. Frontend client: `src/services/api.ts` and `src/types.ts` for member routes; `src/admin/api.ts` and `src/admin/types.ts` for admin routes.
4. API docs: document the operation in `docs/openapi.yaml` (public and member routes) or `docs/openapi-admin.yaml` (`/admin/*`), with its security, parameters, request body constraints from `validation.ts`, responses, and `x-error-codes`; mark Moderator-only operations with `x-required-role: Moderator`. Update `docs/API.md` if the change affects concepts it covers, and add any new error code to its table. `backend/openapi.test.ts` fails if routes, auth modes, rate limits, or error codes and the docs disagree.
5. Tests: `backend/handler.test.ts` / `backend/admin-handler.test.ts` for authorization behavior, `backend/server.test.ts` for session separation and CSRF, and `backend/routes.test.ts` if the route is public.

**Adding a database migration:**

1. Append a new entry to the `migrations` array in `backend/migrations.ts` using the next number (`NNN_snake_case`). This inline SQL is what actually runs.
2. Add the matching reviewable `migrations/NNN_snake_case.sql`, wrapped in `BEGIN;` / `COMMIT;`.
3. Update `backend/migrations-runner.test.ts`.
4. Never edit a migration that has already shipped; add a new one. Destructive (contract-phase) migrations must set `requiresExplicitTarget: true` so they are not applied by default.
5. Never schema-qualify objects (no `public.`) and do not set `search_path`: backup restore replays migrations inside a staging schema with `search_path` set to that schema only, so every migration must work under any `search_path`. `backend/migrations-runner.test.ts` checks this.

**Article visibility:** legacy text levels (`Public`, `Internal`, `Admin`) and AGT numeric levels (`0`–`5`) are both supported. Access rules live in `backend/domain.ts`; display options and colors in `src/visibility.ts`. Keep both in sync and preserve legacy behavior.

**Authentication:** the API supports local accounts only; setting `AUTH_MODE` to anything other than `local` stops the server from starting. `backend/auth.ts` `authenticate()` is the single place a member bearer token becomes a user, so a future provider (such as OIDC) belongs there. Handlers receive the resulting `Actor` on `request.actor` and must not inspect tokens themselves. The Admin is authenticated separately in `backend/admin-auth.ts` (setup with `AGT_SETUP_PASSWORD`, sign-in, SHA-256-hashed cookie sessions); `server.ts` verifies the cookie for `auth: 'admin'` routes and passes `request.admin`. Bearer tokens are ignored on admin routes and the Admin cookie on member routes; never let one grant the other.

**Configuration:** non-secret settings live in `config.yaml`, validated by the Zod schema in `backend/config.ts` (unknown keys are errors); document every key in `config.example.yaml`. Secrets stay in environment variables. Dashboard-editable keys resolve file → `application_settings` → default in `backend/settings-service.ts`, and a key the file defines must never be changeable through any API, migration, or restore.

## Security rules

- The API is the authorization boundary. UI hiding is never an access control: enforce roles, visibility, and protection in backend services.
- Never commit `.env` files, secrets, database URLs, or credentials. `VITE_*` values are public identifiers only; never put secrets in frontend code or Vite variables.
- Markdown is rendered with `react-markdown` + `rehype-sanitize` without raw HTML, and the API rejects HTML/JSX/MDX imports. Do not enable raw HTML or execute content as MDX.
- Updates, restores, and deletes carry the article `version` and must return HTTP `409` on mismatch rather than overwrite concurrent edits.
- Server-owned fields (`created_at`, `created_by`, `modified_at`, `modified_by`, pinning, protection, version) must not be accepted from clients. The only exception is the Admin backup restore in `backend/backup-service.ts`, which restores rows verbatim.
- A new application table must be added to `backupTables` in `backend/backup-service.ts` (in foreign-key order) so backups stay complete. The one exception is `admin_sessions`, listed in `unbackedTables`: it is never backed up and is cleared by every restore. `config.yaml` is included in backups but never restored.

## Documentation and commits

- Update `README.md` when a change affects setup, configuration variables, roles/permissions, or user-visible behavior.
- Commit subjects are short and imperative (e.g. `Add AGT-standard visibility levels`), with `Refs #<issue>` in the body when working from an issue.
