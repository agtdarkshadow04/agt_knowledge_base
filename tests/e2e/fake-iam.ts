import http from 'node:http';

/**
 * A stand-in for AGT IAM's `POST /api/v1/auth/verify` (issue #30), started by
 * `playwright.config.ts` next to the app so the browser tests can sign in with
 * an AGT account without reaching the real service (SEC-14). Run directly by
 * Node, which strips the types.
 */

const port = Number(process.env.FAKE_IAM_PORT ?? 4182);
const apiKey = process.env.FAKE_IAM_API_KEY ?? '';

interface Traveller { id: string; name: string; password: string; permission: string }

const travellers: Traveller[] = [
  { id: 'AGT-E2E-1', name: 'Vega Ranger', password: 'Vega "Star", +1\\', permission: 'Moderator' },
  { id: 'AGT-E2E-2', name: 'Locked Out', password: 'Locked-Out-1', permission: 'NOACCESS' },
];

function send(response: http.ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') return send(response, 200, { status: 'ok' });
  if (request.method !== 'POST' || request.url !== '/api/v1/auth/verify') return send(response, 404, { error: 'NOT_FOUND' });
  if (request.headers['x-api-key'] !== apiKey) return send(response, 401, { error: 'INVALID_API_KEY' });
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { identifier?: string; password?: string; appId?: string };
    const traveller = travellers.find((candidate) => candidate.name === body.identifier);
    if (!traveller) return send(response, 401, { error: 'ERR_IDENTITY_NOT_FOUND' });
    if (traveller.password !== body.password) return send(response, 401, { error: 'ERR_INVALID_CREDENTIALS' });
    send(response, 200, {
      authenticated: true,
      verified: true,
      token: 'fake-iam-token',
      traveller: { travellerName: traveller.name, agtTravellerId: traveller.id, agtStatus: 'Active', securityLevel: '1', community: 'AGT' },
      applicationAuthorization: { requestedAppId: body.appId, permissionAssigned: traveller.permission, isAuthorized: traveller.permission !== 'NOACCESS', accessNotes: '' },
      metadata: { issuer: 'AGT-IAM', expiresIn: '24h', timestamp: new Date().toISOString() },
    });
  });
});

server.listen(port, '127.0.0.1');
