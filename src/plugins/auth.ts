import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import cookie from '@fastify/cookie';
import { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../config/env';

export type SessionRole = 'player' | 'admin';

/** Name of the httpOnly session cookie set at /auth/login. */
export const AUTH_COOKIE = 'auth_token';

// JWT_TTL is an ms-style duration ("7d", "12h", "30m", "3600s" or bare seconds).
// The cookie's Max-Age must match the token's lifetime.
export function jwtTtlSeconds(): number {
  const m = /^(\d+)\s*(s|m|h|d)?$/.exec(env.JWT_TTL.trim());
  if (!m) return 7 * 86400;
  const mult = { s: 1, m: 60, h: 3600, d: 86400 }[m[2] ?? 's']!;
  return Number(m[1]) * mult;
}

export function authCookieOptions() {
  return {
    httpOnly: true,
    // Lax blocks the cookie on cross-site POSTs (CSRF) while still sending it
    // on same-site requests; the SPA is served from the same origin via nginx.
    sameSite: 'lax' as const,
    secure: env.NODE_ENV === 'production',
    path: '/',
    maxAge: jwtTtlSeconds(),
  };
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; email: string; role: SessionRole };
    user: { sub: string; email: string; role: SessionRole };
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireRole: (
      role: SessionRole,
    ) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

// Expired tokens get their own code so the frontend can say "session expired,
// sign in again" instead of a generic auth failure.
function unauthorizedPayload(err: unknown) {
  const code =
    typeof err === 'object' && err !== null && 'code' in err &&
    String((err as { code: unknown }).code).includes('EXPIRED')
      ? 'token_expired'
      : 'unauthorized';
  return { error: 'unauthorized', code };
}

export default fp(async (app) => {
  app.register(cookie);

  // Tokens expire so a leaked one is not a permanent credential. The client
  // re-logs-in through Google/Apple when it gets a 401. The token is read from
  // the Authorization header when present, otherwise from the httpOnly cookie.
  app.register(jwt, {
    secret: env.JWT_SECRET,
    sign: { expiresIn: env.JWT_TTL },
    cookie: { cookieName: AUTH_COOKIE, signed: false },
  });

  app.decorate('authenticate', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await req.jwtVerify();
    } catch (err) {
      await reply.code(401).send(unauthorizedPayload(err));
    }
  });

  app.decorate('requireRole', (role: SessionRole) => {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        await req.jwtVerify();
      } catch (err) {
        return reply.code(401).send(unauthorizedPayload(err));
      }
      if (req.user.role !== role) {
        return reply.code(403).send({ error: 'forbidden', code: 'forbidden' });
      }
    };
  });
});
