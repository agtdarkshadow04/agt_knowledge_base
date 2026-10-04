# AGT Knowledge Base

A production-oriented knowledge base for the Alliance of Galactic Travellers community. The public React/Vite application supports server-paginated browsing, search, tags, deterministic sorting, safe Markdown rendering, article URLs, linked tables of contents, and responsive AGT styling. Cognito-backed authors can create and edit articles and compare the five most recent revisions; Administrators additionally control protection, restoration, and deletion.

## Architecture

```text
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

## Roles and editing rules

| User | Visible articles | View/compare history | Create | Set visibility | Edit unprotected | Edit protected | Pin | Protect | Restore | Delete |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Public | Public | No | No | No | No | No | No | No | No | No |
| Standard | Public, Internal | Yes | Yes | Public or Internal on unprotected articles | Yes | No | No | No | No | No |
| Admin | All | Yes | Yes | Any level | Yes | Yes | Yes | Yes | Yes | Yes |

Updates, restores, and deletes carry the article version. PostgreSQL applies the mutation only when that version still matches, returning HTTP `409` instead of silently overwriting a concurrent edit. Restoration creates a new latest revision rather than rewriting history.

## Prerequisites

- Node.js 22 or newer and npm
- For local data: Docker Compose or PostgreSQL 16
- For AWS: AWS CLI v2, AWS CDK v2, and credentials authorized to create the resources in `infrastructure/`
- A bootstrapped CDK account/region (`npx cdk bootstrap aws://ACCOUNT/REGION`)

## Local development

1. Install dependencies and create local configuration:

   ```bash
   npm ci
   cp .env.example .env.local
   ```

2. Start PostgreSQL and apply migrations:

   ```bash
   docker compose up -d postgres
   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/agt_knowledge_base npm run db:migrate
   ```

3. Put the deployed Cognito pool and client identifiers in `.env.local`. Start the API and Vite in separate terminals:

   ```bash
   set -a && source .env.local && set +a && npm run api:dev
   npm run dev
   ```

The local API verifies real Cognito ID tokens. It does not provide an insecure authentication bypass. Public browsing works without a token. If you only need frontend development, set `VITE_API_URL` to a deployed API.

## Checks

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run cdk:synth -- -c stage=dev
```

## AWS infrastructure deployment

The CDK stack creates:

- a Cognito user pool, web client, and `Admin` / `Standard` groups;
- an HTTP API with public read routes and JWT-authorized mutation routes;
- ARM64 Node.js Lambdas for the API and schema migrations;
- a two-AZ VPC with isolated subnets and no public database route;
- encrypted RDS PostgreSQL, private security groups, backups, and a Secrets Manager-generated credential;
- a Secrets Manager VPC endpoint so private Lambdas do not require NAT.

Deploy an environment:

```bash
export AWS_REGION=us-east-1
export CDK_DEFAULT_ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
export CDK_DEFAULT_REGION="$AWS_REGION"
npm run cdk:deploy -- -c stage=dev
```

For `stage=prod`, the stack enables Multi-AZ RDS, database and Cognito deletion protection, longer backups, and retained Cognito data. Record the output values `ApiUrl`, `UserPoolId`, `UserPoolClientId`, and `MigrationFunctionName`.

Apply migrations after the database is available:

```bash
aws lambda invoke \
  --function-name <MigrationFunctionName> \
  --cli-binary-format raw-in-base64-out \
  migration-result.json
cat migration-result.json
```

The migration function is not attached to an HTTP route. Only principals allowed to invoke that Lambda can run it. Migrations are recorded in `schema_migrations` and are idempotent.

Migrations marked as requiring an explicit target are destructive contract phases and are not applied by the default invocation. For the canonical-tag rollout, apply the additive phase before deploying the new API, verify it, deploy the API, and only then apply the contract phase:

```bash
aws lambda invoke \
  --function-name <MigrationFunctionName> \
  --cli-binary-format raw-in-base64-out \
  --payload '{"targetId":"006_canonical_tags_expand"}' \
  migration-expand-result.json

# Deploy and verify the canonical-tag API before continuing.

aws lambda invoke \
  --function-name <MigrationFunctionName> \
  --cli-binary-format raw-in-base64-out \
  --payload '{"targetId":"007_canonical_tags_contract"}' \
  migration-contract-result.json
```

For local migration runs, set `MIGRATION_TARGET_ID` to apply through a specific migration. Do not target a contract migration until its corresponding application version is active.

## Establish the first Admin safely

Self-registration is disabled. The bootstrap script requires active AWS credentials, explicit identifiers, and `--confirm`; it never accepts or stores a password. Cognito sends a temporary credential to a newly created user.

```bash
npm run admin:bootstrap -- \
  --user-pool-id <UserPoolId> \
  --username <username> \
  --email <email-address> \
  --confirm
```

Run this from a controlled administrator workstation. Afterwards, use least-privilege Cognito administration to create additional users and place ordinary authors in the `Standard` group. Do not create application-password columns in PostgreSQL; Cognito remains the credential store.

## Amplify frontend deployment

1. Create an Amplify Hosting application connected to `Folfchie/agt_knowledge_base` and select the intended branch (`staging` for pre-production).
2. Amplify detects `amplify.yml`. Configure these environment variables using CDK outputs:

   ```text
   VITE_API_URL=<ApiUrl>
   VITE_COGNITO_USER_POOL_ID=<UserPoolId>
   VITE_COGNITO_USER_POOL_CLIENT_ID=<UserPoolClientId>
   VITE_AWS_REGION=<stack-region>
   ```

3. Add an Amplify rewrite from `/<*>` to `/index.html` with HTTP status `200` so article URLs work on refresh.
4. Deploy the branch and test public reads, both roles, protection changes, conflicts, and sign-out in that environment.

These Vite values are public resource identifiers, not secrets. Never put the RDS secret, database URL, AWS access key, or Cognito user password in Amplify variables or frontend code.

## Data and content security

- SQL values are parameterized; requested sort fields are mapped through a fixed allowlist.
- Markdown is rendered by `react-markdown` with GFM and `rehype-sanitize`; raw HTML is not enabled.
- The API rejects raw HTML, JSX tags, and MDX `import` / `export` statements. MDXEditor is used as a Markdown authoring surface only; content is never executed as MDX.
- Article writes are validated with Zod and capped at 250,000 characters and 12 tags.
- API errors do not return database details. Lambda logs include the API request ID for unexpected failures.
- PostgreSQL timestamps are `timestamptz` values generated by the server and serialized as UTC ISO 8601.

## Repository layout

```text
src/              React UI, Cognito session, safe Markdown, editors
backend/          Lambda handler, domain service, authorization, PostgreSQL adapter
migrations/       Reviewable SQL schema
infrastructure/   AWS CDK stack
scripts/          migration and first-Admin operations
```
