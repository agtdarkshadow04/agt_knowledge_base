import { createDatabase } from '../server/db.js';
import { hashPassword } from '../server/local-auth.js';
import { roles, type Role } from '../server/domain.js';
import { envValue, loadStartup } from '../server/startup.js';

function arg(name: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/**
 * Creates or resets a member account (Editor or Moderator) for recovery. It
 * cannot create the installation Admin; see README for Admin lockout recovery.
 */
function fail(message: string): never {
  console.error(message);
  console.error('Usage: --username <name> --display-name <name> [--email <address>] --role <Editor|Moderator> --confirm');
  console.error('Provide the password through AGT_KNOWLEDGE_BASE_LOCAL_USER_PASSWORD.');
  process.exit(2);
}

const username = arg('username')?.trim().toLowerCase();
const displayName = arg('display-name')?.trim();
const email = arg('email')?.trim().toLowerCase();
const role = arg('role') as Role | undefined;
const warnings: string[] = [];
const password = envValue(process.env, 'LOCAL_USER_PASSWORD', warnings, 'LOCAL_USER_PASSWORD');

if (!process.argv.includes('--confirm')) fail('--confirm is required.');
if (!username || !/^[a-z0-9_.-]{3,64}$/.test(username)) fail('Username must be 3-64 lowercase letters, numbers, dots, underscores, or hyphens.');
if (!displayName || displayName.length > 120) fail('Display name must contain 1-120 characters.');
if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) fail('Email address is invalid.');
if (!role || !roles.includes(role)) fail('Role must be Editor or Moderator. The installation Admin is managed at /admin, not here.');
if (!password || password.length < 12 || !/[a-z]/.test(password) || !/[A-Z]/.test(password)
  || !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
  fail('AGT_KNOWLEDGE_BASE_LOCAL_USER_PASSWORD must contain at least 12 characters, including uppercase, lowercase, a number, and a symbol.');
}

const passwordHash = await hashPassword(password);
let startup;
try {
  startup = loadStartup(process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
for (const warning of [...warnings, ...startup.warnings]) console.warn(warning);
const db = createDatabase(startup.database);
const pool = await db.pool();
try {
  await pool.query(
    `INSERT INTO local_users (username, password_hash, display_name, email, role)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (username) DO UPDATE
       SET password_hash = EXCLUDED.password_hash,
           display_name = EXCLUDED.display_name,
           email = EXCLUDED.email,
           role = EXCLUDED.role,
           is_active = true,
           updated_at = now()`,
    [username, passwordHash, displayName, email ?? null, role],
  );
  console.log(`Member ${role} account ${username} is ready.`);
} finally {
  await db.close();
}
