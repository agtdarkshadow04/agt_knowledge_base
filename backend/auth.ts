import { AppError, type Actor } from './domain.js';
import { verifyLocalToken, type LocalSessionUser } from './local-auth.js';
import type { ApiRequest } from './routes.js';

export type AuthenticatedUser = Omit<LocalSessionUser, 'sessionVersion'>;

/**
 * Resolves a bearer token to the signed-in user, or throws if it is invalid.
 * This is the only place the API turns credentials into an identity, so an
 * additional provider (such as OIDC) belongs here.
 */
export async function authenticate(token: string): Promise<AuthenticatedUser> {
  const user = await verifyLocalToken(token);
  return {
    sub: user.sub,
    username: user.username,
    displayName: user.displayName,
    email: user.email,
    role: user.role,
    isSuperAdmin: user.isSuperAdmin,
  };
}

export function toActor(user: AuthenticatedUser): Actor {
  return {
    sub: user.sub,
    role: user.role,
    displayName: user.displayName.slice(0, 120),
    email: user.email?.slice(0, 254),
    isSuperAdmin: user.isSuperAdmin,
  };
}

export function requireActor(request: Pick<ApiRequest, 'actor'>): Actor {
  if (!request.actor) throw new AppError('Authentication is required.', 401, 'UNAUTHENTICATED');
  return request.actor;
}

export function requireAdmin(request: Pick<ApiRequest, 'actor'>): Actor {
  const actor = requireActor(request);
  if (actor.role !== 'Admin') {
    throw new AppError('Administrator access is required.', 403, 'FORBIDDEN');
  }
  return actor;
}

export function requireSuperAdmin(request: Pick<ApiRequest, 'actor'>): Actor {
  const actor = requireAdmin(request);
  if (!actor.isSuperAdmin) {
    throw new AppError('Super administrator access is required.', 403, 'FORBIDDEN');
  }
  return actor;
}
