import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { parse } from '../../lib/validate';
import { AppError } from '../../lib/errors';
import { db } from '../../db/client';
import { sports } from '../../db/schema';

const createBody = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/, 'slug must be lowercase letters, numbers, and hyphens only'),
});

// Sports change only when an admin creates one, so the list is served from
// memory and re-read from the DB after every write. If sports are ever
// modified outside this process (another instance, manual SQL), restart the
// server or the cache goes stale.
type Sport = typeof sports.$inferSelect;
let sportsCache: Sport[] | null = null;

async function loadSports(): Promise<Sport[]> {
  if (sportsCache === null) {
    sportsCache = await db.select().from(sports).orderBy(sports.name);
  }
  return sportsCache;
}

export function invalidateSportsCache() {
  sportsCache = null;
}

export async function sportsRoutes(app: FastifyInstance) {
  app.get('/sports', async () => {
    return loadSports();
  });

  app.post('/sports', { preHandler: app.requireRole('admin') }, async (req, reply) => {
    const body = parse(createBody, req.body);

    const existing = (
      await db.select().from(sports).where(eq(sports.slug, body.slug)).limit(1)
    )[0];
    if (existing) {
      throw new AppError('a sport with this slug already exists', 409);
    }

    const created = (
      await db.insert(sports).values({ name: body.name, slug: body.slug }).returning()
    )[0];

    invalidateSportsCache();
    return reply.code(201).send(created);
  });
}
