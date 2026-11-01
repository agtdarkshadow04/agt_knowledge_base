import { runMigrations } from '../backend/migrations-runner.js';

const targetId = process.env.MIGRATION_TARGET_ID;
const result = await runMigrations(targetId ? { targetId } : {});
console.log(result.applied.length ? `Applied: ${result.applied.join(', ')}` : 'Database schema is current.');
