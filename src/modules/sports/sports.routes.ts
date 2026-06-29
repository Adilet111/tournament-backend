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

export async function sportsRoutes(app: FastifyInstance) {
  app.get('/sports', async () => {
    return db.select().from(sports).orderBy(sports.name);
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

    return reply.code(201).send(created);
  });
}
