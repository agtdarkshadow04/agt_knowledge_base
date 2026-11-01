# AGENTS.md

Guidance for AI coding agents working in this repository. Human-facing setup and deployment instructions live in `README.md`; security expectations live in `SECURITY.md`. Read both before making non-trivial changes.

## Project overview

AGT Knowledge Base is a TypeScript knowledge base for the Alliance of Galactic Travellers: a React 19 + Vite frontend, a Node.js API, and PostgreSQL. It is self-hosted with Docker: Nginx → Node.js API (`backend/local-server.ts`) → PostgreSQL, with local username/password auth.

The former AWS deployment (Amplify Hosting, API Gateway, Lambda, RDS, Cognito) has been removed from this branch: no code, packages, or schema names depend on AWS. Do not add AWS dependencies. Users are keyed by `app_users.user_id`; migration `011_rename_user_key` renamed it from `cognito_sub`, and existing Cognito subjects keep their values so migrated authorship stays intact.

## Branches

- `main` is the default branch. Base work on it unless told otherwise.
- `staging` is frozen: AWS Amplify builds the existing AWS test deployment from it. Never push to, merge into, rebase, or delete `staging`.

## Repository layout

```text
src/              React UI: pages/, components/, auth/, settings/, services/api.ts (API client)
backend/          API: routes.ts (route table + ApiRequest/ApiResponse types),
                  local-server.ts (Node HTTP server: matching, authentication, setup/login),
                  auth.ts (token-to-user step, requireActor/requireAdmin/requireSuperAdmin),
                  local-auth.ts (password hashing, signed session tokens), db.ts (pg pool),
                  handler.ts (route dispatch to services),
                  *-service.ts (domain logic; backup-service.ts exports/restores
                  every table), domain.ts (types, roles, visibility, AppError classes),
                  validation.ts (Zod request parsing), repository.ts (interfaces),
                  postgres-article-repository.ts (SQL), migrations.ts + migrations-runner.ts
migrations/       Reviewable SQL copies of each migration
scripts/          migrate, local-user recovery CLI
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

1. `backend/routes.ts` — add the route to the table, with `authenticated: true` unless it is a public read.
2. `backend/handler.ts` — add the `case` to the `switch (request.routeKey)` dispatch, enforcing roles with `requireActor`/`requireAdmin`/`requireSuperAdmin`. `backend/routes.test.ts` fails if the table and the switch disagree. The exceptions are the login, session, and setup routes, which `local-server.ts` serves itself; they are listed in `serverRoutes` in `backend/routes.test.ts`, so a new server-served route must be added there too.
3. `src/services/api.ts` — the frontend client, plus types in `src/types.ts`.
4. `backend/handler.test.ts` for authorization behavior, and `backend/routes.test.ts` if the route is public.

**Adding a database migration:**

1. Append a new entry to the `migrations` array in `backend/migrations.ts` using the next number (`NNN_snake_case`). This inline SQL is what actually runs.
2. Add the matching reviewable `migrations/NNN_snake_case.sql`, wrapped in `BEGIN;` / `COMMIT;`.
3. Update `backend/migrations-runner.test.ts`.
4. Never edit a migration that has already shipped; add a new one. Destructive (contract-phase) migrations must set `requiresExplicitTarget: true` so they are not applied by default.

**Article visibility:** legacy text levels (`Public`, `Internal`, `Admin`) and AGT numeric levels (`0`–`5`) are both supported. Access rules live in `backend/domain.ts`; display options and colors in `src/visibility.ts`. Keep both in sync and preserve legacy behavior.

**Authentication:** the API supports local accounts only; setting `AUTH_MODE` to anything other than `local` stops the server from starting. `backend/auth.ts` `authenticate()` is the single place a bearer token becomes a user, so a future provider (such as OIDC) belongs there. Handlers receive the resulting `Actor` on `request.actor` and must not inspect tokens themselves.

## Security rules

- The API is the authorization boundary. UI hiding is never an access control: enforce roles, visibility, and protection in backend services.
- Never commit `.env` files, secrets, database URLs, or credentials. `VITE_*` values are public identifiers only; never put secrets in frontend code or Vite variables.
- Markdown is rendered with `react-markdown` + `rehype-sanitize` without raw HTML, and the API rejects HTML/JSX/MDX imports. Do not enable raw HTML or execute content as MDX.
- Updates, restores, and deletes carry the article `version` and must return HTTP `409` on mismatch rather than overwrite concurrent edits.
- Server-owned fields (`created_at`, `created_by`, `modified_at`, `modified_by`, pinning, protection, version) must not be accepted from clients. The only exception is the super-administrator database restore in `backend/backup-service.ts`, which restores rows verbatim.
- A new application table must be added to `backupTables` in `backend/backup-service.ts` (in foreign-key order) so backups stay complete.

## Documentation and commits

- Update `README.md` when a change affects setup, configuration variables, roles/permissions, or user-visible behavior.
- Commit subjects are short and imperative (e.g. `Add AGT-standard visibility levels`), with `Refs #<issue>` in the body when working from an issue.
