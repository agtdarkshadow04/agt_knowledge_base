# AGT Knowledge Base

A production-oriented knowledge base for the Alliance of Galactic Travellers community. The public React/Vite application supports server-paginated browsing, search, tags, deterministic sorting, safe Markdown rendering, article URLs, linked tables of contents, and responsive AGT styling. Authenticated authors can create and edit articles and compare the five most recent revisions; Administrators additionally control protection, restoration, and deletion.

## Architecture

```text
Browser -> Nginx -> Node.js API -> PostgreSQL
              Docker Compose

Browser / AWS Amplify Hosting
        |
        | HTTPS + Cognito ID token on writes
        v
Amazon API Gateway HTTP API
        |
        | public GET / Cognito-authorized mutations
        v
AWS Lambda (private VPC subnets)
        |
        | credentials loaded at runtime
        +---- AWS Secrets Manager (VPC endpoint)
        |
        +---- Amazon RDS PostgreSQL (private, encrypted)
```

The browser never connects to PostgreSQL and contains no database credential. API Gateway validates Cognito tokens on every authenticated route; the Lambda service repeats role, visibility, and resource checks before reading or changing data. `created_at`, `created_by`, `modified_at`, `modified_by`, pinning, protection, and version fields are server-owned.

The Docker deployment is independent of AWS: Nginx serves the built frontend and proxies `/api` to the Node.js API, local users and password hashes are stored in PostgreSQL, and signed sessions are verified by the API. PostgreSQL is reachable only through the private Compose network and an optional loopback-only development port. The AWS deployment is being retired: its infrastructure code now lives only on the frozen `staging` branch, which the existing AWS test deployment builds from.

## Roles and editing rules

| User | Visible articles | View/compare history | Create | Set visibility | Edit unprotected | Edit protected | Pin | Protect | Restore | Delete |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Public | Public (legacy or AGT level 0) | No | No | No | No | No | No | No | No | No |
| Standard | Public, Internal, Private | Yes | Yes | Public, Internal, or AGT levels 0–1 on unprotected articles | Yes | No | No | No | No | No |
| Admin | All | Yes | Yes | Any level | Yes | Yes | Yes | Yes | Yes | Yes |

AGT-standard visibility is stored as numeric levels: `0` Public (`#2aff00`), `1` Private (`#00f4ff`), `2` Restricted (`#f198e2`), `3` Top Secret (`#fd0303`), `4` SLT Restricted (`#ff9300`), and `5` SCC Restricted (`#3287f0`). Public and Standard users can read level 0, Standard users can also read level 1, and levels 2–5 are Admin-only. The legacy text values Public, Internal, and Admin remain supported with their existing access rules and colors.

Updates, restores, and deletes carry the article version. PostgreSQL applies the mutation only when that version still matches, returning HTTP `409` instead of silently overwriting a concurrent edit. Restoration creates a new latest revision rather than rewriting history.

## Prerequisites

- Node.js 22 or newer and npm
- For local data: Docker Compose or PostgreSQL 16

## Local development

1. Install dependencies and create local configuration:

   ```bash
   npm ci
   cp .env.example .env.local
   ```

2. Start PostgreSQL and apply migrations:

   ```bash
   POSTGRES_PASSWORD=postgres \
     LOCAL_AUTH_SECRET=local-development-only-secret-32-chars \
     docker compose up -d postgres
   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/agt_knowledge_base npm run db:migrate
   ```

3. Start the API and Vite in separate terminals:

   ```bash
   set -a && source .env.local && set +a && npm run api:dev
   npm run dev
   ```

Open the app and complete the first-run setup to create the initial Administrator. The API verifies signed local session tokens and does not provide an insecure authentication bypass. Public browsing works without a token.

## Docker self-hosting

The Compose stack runs the web frontend, API, schema migrations, PostgreSQL, and local authentication. It requires no AWS account, credentials, or services.

1. Install Docker Engine with the Compose plugin, clone this repository, and check out the `docker` branch.
2. Create the deployment configuration:

   ```bash
   cp docker.env.example .env
   ```

   Replace `POSTGRES_PASSWORD` and `LOCAL_AUTH_SECRET` with independent random values. For example, `openssl rand -hex 32` generates a suitable value for either setting. If the site will be reached anywhere other than `http://localhost:8080`, also set `APP_ORIGIN` to its externally visible origin. These secrets must not be committed.

3. Build and start the stack:

   ```bash
   docker compose up -d --build
   docker compose ps
   ```

   The one-shot `migrate` service waits for PostgreSQL, applies pending non-destructive migrations, and must finish successfully before the API starts.

4. Open `http://localhost:8080` (or the configured host and port). A fresh installation redirects to `/setup`, where the first visitor creates the single protected super administrator. Setup is transactionally locked and is permanently disabled as soon as any local user exists. After setup, use **Admin → Users** to create, update, deactivate, reset passwords for, or remove eligible local users.

The super administrator cannot be deleted, deactivated, or demoted. Other administrators cannot change that account's credentials or identity. The super administrator can update their own profile and password from the Users section. **Admin → Data** contains archive statistics, article inventory, and canonical/orphan tag management. **Admin → Application settings** controls branding, default article visibility, and public browsing. Personal accessibility, download, and search-view preferences remain browser-local in the Settings dialog.

The command-line user tool is retained for recovery only. For example, an upgraded installation with local users but no active Admin deliberately fails migration `009_admin`; use the recovery command below to activate or create an Admin against the pre-migration schema, then rerun `docker compose up -d --build`:

```bash
read -rsp "Recovery password: " LOCAL_USER_PASSWORD && echo
export LOCAL_USER_PASSWORD
docker compose run --rm --no-deps -e LOCAL_USER_PASSWORD api \
  node server/scripts/manage-local-user.js \
  --username recovery-admin \
  --display-name "Recovery Administrator" \
  --role Admin \
  --confirm
unset LOCAL_USER_PASSWORD
```

Do not use the CLI as the normal first-run flow. After migration `009_admin` succeeds, perform routine account management in the application.

Configuration is read from `.env`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `APP_BIND_ADDRESS` | `0.0.0.0` | Host interface exposed by the web container |
| `APP_PORT` | `8080` | Host HTTP port |
| `APP_ORIGIN` | `http://localhost:8080` | Browser origin allowed by the API |
| `POSTGRES_DB` | `agt_knowledge_base` | PostgreSQL database name |
| `POSTGRES_USER` | `postgres` | PostgreSQL user |
| `POSTGRES_PASSWORD` | none | Required PostgreSQL password |
| `POSTGRES_BIND_ADDRESS` | `127.0.0.1` | Interface for optional host database access |
| `POSTGRES_PORT` | `5432` | Host PostgreSQL port |
| `LOCAL_AUTH_SECRET` | none | Required secret used to sign local sessions; at least 32 characters |
| `LOCAL_AUTH_SESSION_HOURS` | `12` | Session lifetime, from 1 to 168 hours |

Changing `LOCAL_AUTH_SECRET` immediately invalidates every active session. For an internet-facing deployment, place a TLS-terminating reverse proxy in front of `APP_PORT`; passwords and bearer tokens must not be sent over plaintext HTTP. Do not expose the PostgreSQL port beyond loopback.

Useful operations:

```bash
docker compose logs -f web api migrate postgres
docker compose up -d --build       # rebuild after pulling an update
docker compose down                # stop containers without deleting data
```

The `agt-postgres` volume contains the database. Back it up before upgrades, and do not run `docker compose down --volumes` unless you intend to permanently delete the data.

References: [Install Docker Engine](https://docs.docker.com/engine/install/) and [install Docker Compose](https://docs.docker.com/compose/install/).

## Checks

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

## Database migrations

Migrations are recorded in `schema_migrations` and are idempotent. `npm run db:migrate` (and the Compose `migrate` service) applies every pending non-destructive migration.

Migrations marked as requiring an explicit target are destructive contract phases and are not applied by default. Set `MIGRATION_TARGET_ID` to apply through a specific migration, for example `MIGRATION_TARGET_ID=007_canonical_tags_contract npm run db:migrate`. Do not target a contract migration until the application version that depends on it is running.

## Data and content security

- SQL values are parameterized; requested sort fields are mapped through a fixed allowlist.
- Docker-local passwords are hashed with scrypt and random salts; local sessions use expiring HMAC signatures and login attempts are rate-limited by Nginx.
- Markdown is rendered by `react-markdown` with GFM and `rehype-sanitize`; raw HTML is not enabled.
- The API rejects raw HTML, JSX tags, and MDX `import` / `export` statements. MDXEditor is used as a Markdown authoring surface only; content is never executed as MDX.
- Article writes are validated with Zod and capped at 250,000 characters and 12 tags.
- API errors do not return database details. API logs include a request ID for unexpected failures.
- PostgreSQL timestamps are `timestamptz` values generated by the server and serialized as UTC ISO 8601.

## Repository layout

```text
src/              React UI, authentication session, safe Markdown, editors
backend/          HTTP server, route table, domain services, authorization, PostgreSQL adapter
migrations/       Reviewable SQL schema
scripts/          migration and local-user recovery
```
