import { HttpError } from './http.js';
import type { Actor } from './domain.js';
import type { ApiRequest } from './routes.js';
import type { MemberUser } from './session.js';

/** The signed-in member, as the session cookie lookup in `server/session.ts` returns it. */
export type AuthenticatedUser = MemberUser;

export function toActor(user: AuthenticatedUser): Actor {
  return {
    sub: user.sub,
    role: user.role,
    displayName: user.displayName.slice(0, 120),
    email: user.email?.slice(0, 254),
  };
}

export function requireActor(request: Pick<ApiRequest, 'actor'>): Actor {
  if (!request.actor) throw new HttpError(401, 'unauthorized', 'Authentication is required.', { legacyCode: 'UNAUTHENTICATED' });
  return request.actor;
}

/** The signed-in Admin; admin routes call this instead of reading `request.actor`. */
export function requireAdminSession(request: Pick<ApiRequest, 'admin'>) {
  if (!request.admin) throw new HttpError(401, 'unauthorized', 'Admin authentication is required.', { legacyCode: 'UNAUTHENTICATED' });
  return request.admin;
}
