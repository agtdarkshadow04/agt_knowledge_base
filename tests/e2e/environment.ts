import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The browser tests' server environment (TEST-6): a fresh PostgreSQL database
 * and its preview database, created through AGT_KNOWLEDGE_BASE_TEST_DATABASE_URL
 * (the same role the server tests use, TEST-3), a temporary data directory, a
 * test config.yaml and a setup password, so every run starts from first run.
 * `playwright.config.ts` calls this once, before Playwright starts the server.
 */

export const port = 4181;
export const baseURL = `http://127.0.0.1:${port}`;
export const setupPassword = 'E2e-setup-password-1!';
export const database = 'agt_knowledge_base_e2e';
/** The fake AGT IAM (`fake-iam.ts`) and the API key the app sends it. */
export const iamPort = 4182;
export const iamApiKey = 'e2e-iam-api-key';

export function prepare(env: NodeJS.ProcessEnv) {
  const url = env.AGT_KNOWLEDGE_BASE_TEST_DATABASE_URL;
  if (!url) {
    throw new Error('AGT_KNOWLEDGE_BASE_TEST_DATABASE_URL is not set. The browser tests need a PostgreSQL 18 server and a non-superuser role with CREATEDB (README, Development).');
  }
  const parsed = new URL(url);
  // Recreate the databases with the role's own psql-free path: a tiny Node script using pg.
  const script = `
    const pg = require('pg');
    (async () => {
      const client = new pg.Client({ connectionString: process.argv[1] });
      await client.connect();
      for (const name of [process.argv[2], process.argv[2] + '_preview']) {
        await client.query('DROP DATABASE IF EXISTS "' + name + '" WITH (FORCE)');
        await client.query('CREATE DATABASE "' + name + '"');
      }
      await client.end();
    })().catch((error) => { console.error(error.message); process.exit(1); });`;
  execFileSync(process.execPath, ['-e', script, url, database], { stdio: 'inherit' });

  const dataDir = mkdtempSync(join(tmpdir(), 'agt-kb-e2e-'));
  const configFile = join(dataDir, 'config.yaml');
  writeFileSync(configFile, [
    'server:',
    '  host: 127.0.0.1',
    `  port: ${port}`,
    'storage:',
    `  dataDir: ${JSON.stringify(dataDir)}`,
    'database:',
    `  host: ${JSON.stringify(parsed.hostname)}`,
    `  port: ${parsed.port || 5432}`,
    `  name: ${database}`,
    `  user: ${JSON.stringify(decodeURIComponent(parsed.username))}`,
    `  previewName: ${database}_preview`,
    // Generous limits: the suite signs in many times from one address.
    'rateLimits:',
    '  login:',
    '    max: 1000',
    '  setup:',
    '    max: 1000',
    // AGT sign-in against the fake IAM; iam.enabled stays a dashboard setting, off until iam.spec.ts turns it on.
    'iam:',
    `  baseUrl: http://127.0.0.1:${iamPort}`,
    '  appId: e2e-app',
    '  roleMap:',
    '    Moderator: Moderator',
    '',
  ].join('\n'));
  return {
    NODE_ENV: 'production',
    AGT_KNOWLEDGE_BASE_CONFIG_FILE: configFile,
    AGT_KNOWLEDGE_BASE_DB_PASSWORD: decodeURIComponent(parsed.password),
    AGT_KNOWLEDGE_BASE_SETUP_PASSWORD: setupPassword,
    AGT_KNOWLEDGE_BASE_IAM_API_KEY: iamApiKey,
    AGT_KNOWLEDGE_BASE_STATIC_DIR: 'dist',
    PATH: env.PATH ?? '',
  };
}
