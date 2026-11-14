import type { AppConfig } from './config.js';
import type { Database } from './db.js';

/**
 * Everything the routes and services need, built once by `server/index.ts`
 * (SRV-1, SRV-3). Nothing else reads the environment or the config file.
 */
export interface AppContext {
  /** The validated `config.yaml`, with defaults applied. Never changes at runtime. */
  readonly config: AppConfig;
  /** The configuration file as read at startup; backups copy its text, restores never write it. */
  readonly configFile: { readonly path: string; readonly text: string | null };
  readonly db: Database;
  /** `AGT_SETUP_PASSWORD`, or null when it is unset or empty. */
  readonly setupPassword: string | null;
  /** `LOCAL_AUTH_SECRET`, which signs member tokens. */
  readonly localAuthSecret: string;
  /** The app version from `package.json`. */
  readonly version: string;
}
