import { createDatabase, databaseSettingsFromEnv } from '../server/db.js';
import { runMigrations } from '../server/migrations-runner.js';

const targetId = process.env.MIGRATION_TARGET_ID;
const db = createDatabase(databaseSettingsFromEnv(process.env));
try {
  const result = await runMigrations(db, targetId ? { targetId } : {});
  console.log(result.applied.length ? `Applied: ${result.applied.join(', ')}` : 'Database schema is current.');
} finally {
  await db.close();
}
