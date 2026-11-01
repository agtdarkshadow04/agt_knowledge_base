# AGENTS.md

Guidance for AI coding agents working in this repository. Human-facing setup and deployment instructions live in `README.md`; security expectations live in `SECURITY.md`. Read both before making non-trivial changes.

## Project overview

AGT Knowledge Base is a TypeScript knowledge base for the Alliance of Galactic Travellers: a React 19 + Vite frontend, a Node.js API, and PostgreSQL. It ships in two independent deployment shapes that share the same backend code:

- **Docker (self-hosted):** Nginx → Node.js API (`backend/local-server.ts`) → PostgreSQL, with local username/password auth (`AUTH_MODE=local`, `VITE_AUTH_MODE=local`).
- **AWS:** Amplify Hosting → API Gateway → Lambda (`backend/handler.ts`) → RDS PostgreSQL, with Cognito auth. Defined in `infrastructure/` (CDK).

## Branches

- `docker` is the current working branch. Base work on it unless told otherwise.
- `staging` is the Amplify pre-production branch; `main` is the default branch.

## Repository layout

```text
src/              React UI: pages/, components/, auth/, settings/, services/api.ts (API client)
backend/          API: handler.ts (route dispatch; Lambda entry point, also called by local-server.ts),
                  local-server.ts (Node HTTP server for Docker/dev: routing, auth, setup/login),
                  *-service.ts (domain logic), domain.ts (types, roles, visibility, AppError classes),
                  validation.ts (Zod request parsing), repository.ts (interfaces),
                  postgres-article-repository.ts (SQL), migrations.ts + migrate-handler.ts
migrations/       Reviewable SQL copies of each migration
infrastructure/   AWS CDK stack (API Gateway routes, Lambda, RDS, Cognito)
scripts/          migrate, AWS first-admin bootstrap, local-user recovery CLI
```

## Commands

Requires Node.js 22+. Install with `npm ci`.

```bash
npm run lint        # ESLint, zero warnings allowed
npm run typecheck   # tsc -b over app and node projects
npm test            # Vitest, single run
npm run build       # typecheck + Vite production build
npm run cdk:synth -- -c stage=dev   # only when infrastructure/ changes
```

Run a single test file with `npx vitest run path/to/file.test.ts`. Before finishing, run lint, typecheck, and the relevant tests; run the full suite and build for changes that cross the frontend/backend boundary. Do not run `npm run cdk:deploy`, `npm run admin:bootstrap`, or migrations against a real database unless explicitly asked.

## Code conventions

- TypeScript `strict`, ES modules. No Prettier is configured: match the surrounding style (2-space indent, single quotes, semicolons, trailing commas).
- Backend, scripts, and infrastructure use `NodeNext` resolution, so relative imports **must** end in `.js` (e.g. `import { AppError } from './domain.js';`). Frontend imports under `src/` are extensionless.
- Validate request input in `backend/validation.ts` with Zod; signal domain failures with the `AppError` subclasses in `backend/domain.ts` rather than ad-hoc errors.
- Keep SQL in `postgres-article-repository.ts` (or `admin-service.ts` for local users) and always parameterize values; map user-supplied sort fields through the existing allowlist.
- Keep changes minimal and consistent with existing patterns; do not add dependencies without a clear need.

## Tests

- Tests are colocated as `*.test.ts` / `*.test.tsx` next to the code they cover.
- Frontend tests run in jsdom with Testing Library (`src/test/setup.ts`). Backend test files begin with `// @vitest-environment node` and use in-memory fakes of the repository interfaces rather than a real database.
- Vitest runs with a single worker and no file parallelism; do not change that to speed up runs.
- Per `SECURITY.md`, changes to role handling, protected-article rules, visibility, Markdown rendering, SQL construction, or optimistic concurrency must include regression tests.

## Cross-cutting change checklists

**Adding or changing an API route** — update every place routes are declared:

1. `backend/handler.ts` — the `switch (event.routeKey)` dispatch.
2. `backend/local-server.ts` — `routeKey()` path matching, and the authenticated-route list if the route requires a token.
3. `infrastructure/stack.ts` — `api.addRoutes(...)`, with `authorizer` for authenticated routes.
4. `src/services/api.ts` — the frontend client, plus types in `src/types.ts`.
5. `backend/handler.test.ts` for routing/authorization behavior.

**Adding a database migration:**

1. Append a new entry to the `migrations` array in `backend/migrations.ts` using the next number (`NNN_snake_case`). This inline SQL is what actually runs.
2. Add the matching reviewable `migrations/NNN_snake_case.sql`, wrapped in `BEGIN;` / `COMMIT;`.
3. Update `backend/migrate-handler.test.ts`.
4. Never edit a migration that has already shipped; add a new one. Destructive (contract-phase) migrations must set `requiresExplicitTarget: true` so they are not applied by default.

**Article visibility:** legacy text levels (`Public`, `Internal`, `Admin`) and AGT numeric levels (`0`–`5`) are both supported. Access rules live in `backend/domain.ts`; display options and colors in `src/visibility.ts`. Keep both in sync and preserve legacy behavior.

**Auth modes:** behavior differs between Cognito and local auth (for example, `POST /auth/login`, `/setup`, and the `/admin/users` routes exist only in local mode). Make sure a change works, or is deliberately disabled, in both.

## Security rules

- The API is the authorization boundary. UI hiding is never an access control: enforce roles, visibility, and protection in backend services.
- Never commit `.env` files, secrets, database URLs, or credentials. `VITE_*` values are public identifiers only; never put secrets in frontend code or Vite variables.
- Markdown is rendered with `react-markdown` + `rehype-sanitize` without raw HTML, and the API rejects HTML/JSX/MDX imports. Do not enable raw HTML or execute content as MDX.
- Updates, restores, and deletes carry the article `version` and must return HTTP `409` on mismatch rather than overwrite concurrent edits.
- Server-owned fields (`created_at`, `created_by`, `modified_at`, `modified_by`, pinning, protection, version) must not be accepted from clients.

## Documentation and commits

- Update `README.md` when a change affects setup, configuration variables, roles/permissions, or user-visible behavior.
- Commit subjects are short and imperative (e.g. `Add AGT-standard visibility levels`), with `Refs #<issue>` in the body when working from an issue.
