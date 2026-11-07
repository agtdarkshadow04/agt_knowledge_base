import { AppError, type Actor } from './domain.js';
import { verifyLocalToken, type LocalSessionUser } from './local-auth.js';
import type { ApiRequest } from './routes.js';

export type AuthenticatedUser = Omit<LocalSessionUser, 'sessionVersion'>;

/**
 * Resolves a member bearer token to the signed-in user, or throws if it is
 * invalid. This is the only place the API turns member credentials into an
 * identity, so an additional provider (such as OIDC) belongs here. The
 * installation Admin authenticates separately, with the cookie session in
 * `admin-auth.ts`, and never becomes an `Actor`.
 */
export async function authenticate(token: string): Promise<AuthenticatedUser> {
  const user = await verifyLocalToken(token);
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
  if (!request.actor) throw new AppError('Authentication is required.', 401, 'UNAUTHENTICATED');
  return request.actor;
}

/** The signed-in Admin; admin routes call this instead of reading `request.actor`. */
export function requireAdminSession(request: Pick<ApiRequest, 'admin'>) {
  if (!request.admin) throw new AppError('Admin authentication is required.', 401, 'UNAUTHENTICATED');
  return request.admin;
}
