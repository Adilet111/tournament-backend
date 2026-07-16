import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { OAuth2Client } from 'google-auth-library';
import { parse } from '../../lib/validate';
import { AppError } from '../../lib/errors';
import { db } from '../../db/client';
import { authIdentities, users } from '../../db/schema';
import { adminEmails, env } from '../../config/env';
import { AUTH_COOKIE, authCookieOptions, type SessionRole } from '../../plugins/auth';
import { birthDateSchema } from '../../lib/eligibility';

interface OAuthClaims {
  providerUid: string;
  email: string;
  name?: string;
}

const googleClient = new OAuth2Client(env.GOOGLE_CLIENT_ID);

/**
 * Verify the incoming id token and return the user's claims.
 *  - Google: validate the signature/expiry via google-auth-library and check
 *    `aud === GOOGLE_CLIENT_ID`.
 *  - Apple: verify the RS256 signature against Apple's JWKS
 *    (https://appleid.apple.com/auth/keys), check iss + aud. (Not yet implemented.)
 */
async function verifyToken(
  provider: 'google' | 'apple',
  idToken: string,
): Promise<OAuthClaims> {
  if (provider !== 'google') {
    throw new AppError('Apple login not implemented yet', 501);
  }
  if (!env.GOOGLE_CLIENT_ID) {
    throw new AppError('GOOGLE_CLIENT_ID is not configured on the server', 500);
  }

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: env.GOOGLE_CLIENT_ID,
    });
    payload = ticket.getPayload();
  } catch {
    throw new AppError('Invalid Google id token', 401);
  }

  if (!payload?.sub || !payload.email) {
    throw new AppError('Google id token is missing required claims', 401);
  }
  if (!payload.email_verified) {
    throw new AppError('Google account email is not verified', 401);
  }

  return { providerUid: payload.sub, email: payload.email, name: payload.name };
}

// Find or create the user for an OAuth identity; first admin-listed email
// becomes an admin (that's how "me by default" works). `birthDate` (collected
// by the frontend on the sign-up screen) is stored on first user creation and
// back-filled if the user has none yet — never overwritten once set.
async function upsertUser(
  provider: 'google' | 'apple',
  claims: OAuthClaims,
  birthDate?: string,
) {
  const identity = await db
    .select()
    .from(authIdentities)
    .where(
      and(
        eq(authIdentities.provider, provider),
        eq(authIdentities.providerUid, claims.providerUid),
      ),
    )
    .limit(1);

  if (identity[0]) {
    let user = (
      await db.select().from(users).where(eq(users.id, identity[0].userId)).limit(1)
    )[0];
    // Back-fill birth date for a returning user who never provided one.
    if (user && !user.birthDate && birthDate) {
      user = (
        await db.update(users).set({ birthDate }).where(eq(users.id, user.id)).returning()
      )[0];
    }
    return user;
  }

  const email = claims.email.toLowerCase();
  let user = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0];
  if (!user) {
    const role: SessionRole = adminEmails.includes(email) ? 'admin' : 'player';
    user = (
      await db.insert(users).values({ email, name: claims.name, role, birthDate }).returning()
    )[0];
  } else if (!user.birthDate && birthDate) {
    user = (
      await db.update(users).set({ birthDate }).where(eq(users.id, user.id)).returning()
    )[0];
  }
  await db
    .insert(authIdentities)
    .values({ userId: user.id, provider, providerUid: claims.providerUid });
  return user;
}

const loginBody = z.object({
  provider: z.enum(['google', 'apple']),
  idToken: z.string().min(10),
  // Optional: the frontend collects it on the sign-up screen (Google doesn't
  // return it). Required in practice to join age-restricted tournaments later.
  birthDate: birthDateSchema.optional(),
});

export async function authRoutes(app: FastifyInstance) {
  // The client gets an id token from the Google/Apple SDK and posts it here.
  // The session JWT is set as an httpOnly cookie (XSS-safe: JS can't read it).
  // It is also still returned in the body for older clients that send it as a
  // Bearer header; the web frontend should ignore it and rely on the cookie.
  app.post('/auth/login', async (req, reply) => {
    const { provider, idToken, birthDate } = parse(loginBody, req.body);
    const claims = await verifyToken(provider, idToken);
    const user = await upsertUser(provider, claims, birthDate);
    const token = app.jwt.sign({ sub: user.id, email: user.email, role: user.role });
    reply.setCookie(AUTH_COOKIE, token, authCookieOptions());
    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        birthDate: user.birthDate,
      },
    };
  });

  // Clears the session cookie. Bearer-token clients just discard their token.
  app.post('/auth/logout', async (_req, reply) => {
    reply.clearCookie(AUTH_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/auth/me', { preHandler: app.authenticate }, async (req) => {
    return { user: req.user };
  });
}
