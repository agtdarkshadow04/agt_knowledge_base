import { runMigrations } from '../backend/migrate-handler.js';

const result = await runMigrations();
console.log(result.applied.length ? `Applied: ${result.applied.join(', ')}` : 'Database schema is current.');
