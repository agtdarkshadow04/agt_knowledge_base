import { HttpError } from './http.js';
import type { Actor } from './domain.js';
import type { LocalAuthService, LocalSessionUser } from './local-auth.js';
import type { ApiRequest } from './routes.js';

export type AuthenticatedUser = Omit<LocalSessionUser, 'sessionVersion'>;

/**
 * Resolves a member bearer token to the signed-in user, or throws if it is
 * invalid. This is the only place the API turns member credentials into an
 * identity, so an additional provider (such as OIDC) belongs here. The
 * installation Admin authenticates separately, with the cookie session in
 * `admin-auth.ts`, and never becomes an `Actor`.
 */
export async function authenticate(localAuth: Pick<LocalAuthService, 'verifyToken'>, token: string): Promise<AuthenticatedUser> {
  const user = await localAuth.verifyToken(token);
  return {
    sub: user.sub,
    username: user.username,
    displayName: user.displayName,
    email: user.email,
    role: user.role,
  };
}

export function toActor(user: AuthenticatedUser): Actor {
  return {
    sub: user.sub,
    role: user.role,
    displayName: user.displayName.slice(0, 120),
    email: user.email?.slice(0, 254),
  };
}

export function requireActor(request: Pick<ApiRequest, 'actor'>): Actor {
  if (!request.actor) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication is required.');
  return request.actor;
}

/** The signed-in Admin; admin routes call this instead of reading `request.actor`. */
export function requireAdminSession(request: Pick<ApiRequest, 'admin'>) {
  if (!request.admin) throw new HttpError(401, 'UNAUTHENTICATED', 'Admin authentication is required.');
  return request.admin;
}
