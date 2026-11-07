import { createServer } from 'node:http';
import { setupPassword } from './admin-auth.js';
import { getConfig, getLoadedConfig } from './config.js';
import { assertLocalAuthConfigured } from './local-auth.js';
import { createApiListener } from './server.js';

if (process.env.AUTH_MODE !== undefined && process.env.AUTH_MODE !== 'local') {
  throw new Error('AUTH_MODE must be local or unset. Cognito authentication is no longer supported.');
}
// Fail at startup, naming the key, if config.yaml is invalid.
const loaded = getLoadedConfig();
assertLocalAuthConfigured();
console.log(loaded.text === null
  ? `No configuration file at ${loaded.path}; using defaults.`
  : `Loaded configuration from ${loaded.path}.`);
if (setupPassword() !== undefined) {
  console.warn('AGT_SETUP_PASSWORD is set. It is only needed until the Admin account exists: remove it from .env and restart.');
}

const { host, port } = getConfig().server;
const listener = createApiListener();
createServer((request, response) => {
  listener(request, response).catch((error: unknown) => {
    console.error('Unhandled request failure', { error });
    if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ code: 'INTERNAL_ERROR', message: 'The archive service encountered an unexpected error.' }));
  });
}).listen(port, host, () => {
  console.log(`AGT API listening on http://${host}:${port}`);
});
