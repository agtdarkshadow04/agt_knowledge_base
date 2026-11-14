import { createDatabase } from '../server/db.js';
import { runMigrations } from '../server/migrations-runner.js';
import { loadStartup } from '../server/startup.js';

let startup;
try {
  startup = loadStartup(process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
for (const warning of startup.warnings) console.warn(warning);
const targetId = process.env.MIGRATION_TARGET_ID;
const db = createDatabase(startup.database);
try {
  const result = await runMigrations(db, targetId ? { targetId } : {});
  console.log(result.applied.length ? `Applied: ${result.applied.join(', ')}` : 'Database schema is current.');
} finally {
  await db.close();
}
