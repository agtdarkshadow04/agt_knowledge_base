import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { AppError, type Actor, type Role } from './domain.js';

function parseGroups(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // Cognito may serialize groups as a comma-delimited claim.
  }
  return value.split(',').map((group) => group.trim().replace(/^[\s["']+|[\s\]"']+$/g, '')).filter(Boolean);
}

export function roleFromClaims(claims: Record<string, unknown>): Role {
  if (claims.role === 'Admin') return 'Admin';
  return parseGroups(claims['cognito:groups']).includes('Admin') ? 'Admin' : 'Standard';
}

export function requireActor(event: APIGatewayProxyEventV2WithJWTAuthorizer): Actor {
  const claims = event.requestContext.authorizer?.jwt?.claims as Record<string, unknown> | undefined;
  const sub = claims?.sub;
  if (typeof sub !== 'string' || !sub) throw new AppError('Authentication is required.', 401, 'UNAUTHENTICATED');
  return {
    sub,
    role: roleFromClaims(claims),
    displayName: String(claims.name ?? claims['cognito:username'] ?? claims.username ?? 'AGT Traveller').slice(0, 120),
    email: typeof claims.email === 'string' ? claims.email.slice(0, 254) : undefined,
  };
}
