import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { parse } from '../../lib/validate';
import { AppError } from '../../lib/errors';
import { db } from '../../db/client';
import { authIdentities, users } from '../../db/schema';
import { adminEmails } from '../../config/env';
import type { SessionRole } from '../../plugins/auth';

interface OAuthClaims {
  providerUid: string;
  email: string;
  name?: string;
}

/**
 * TODO: verify the incoming id token and return the user's claims.
 *  - Google: validate via google-auth-library (or the tokeninfo endpoint),
 *    check `aud === GOOGLE_CLIENT_ID`.
 *  - Apple: verify the RS256 signature against Apple's JWKS
 *    (https://appleid.apple.com/auth/keys), check iss + aud.
 * Until implemented, this returns 501.
 */
async function verifyToken(
  _provider: 'google' | 'apple',
  _idToken: string,
): Promise<OAuthClaims> {
  throw new AppError('OAuth token verification not implemented yet', 501);
}

// Find or create the user for an OAuth identity; first admin-listed email
// becomes an admin (that's how "me by default" works).
async function upsertUser(provider: 'google' | 'apple', claims: OAuthClaims) {
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
    return (await db.select().from(users).where(eq(users.id, identity[0].userId)).limit(1))[0];
  }

  const email = claims.email.toLowerCase();
  let user = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0];
  if (!user) {
    const role: SessionRole = adminEmails.includes(email) ? 'admin' : 'player';
    user = (await db.insert(users).values({ email, name: claims.name, role }).returning())[0];
  }
  await db
    .insert(authIdentities)
    .values({ userId: user.id, provider, providerUid: claims.providerUid });
  return user;
}

const loginBody = z.object({
  provider: z.enum(['google', 'apple']),
  idToken: z.string().min(10),
});

export async function authRoutes(app: FastifyInstance) {
  // The client gets an id token from the Google/Apple SDK and posts it here.
  app.post('/auth/login', async (req) => {
    const { provider, idToken } = parse(loginBody, req.body);
    const claims = await verifyToken(provider, idToken);
    const user = await upsertUser(provider, claims);
    const token = app.jwt.sign({ sub: user.id, email: user.email, role: user.role });
    return {
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    };
  });

  app.get('/auth/me', { preHandler: app.authenticate }, async (req) => {
    return { user: req.user };
  });
}
