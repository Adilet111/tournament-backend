import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { desc, eq } from 'drizzle-orm';
import { parse } from '../../lib/validate';
import { AppError } from '../../lib/errors';
import { db } from '../../db/client';
import { competitions } from '../../db/schema';

/**
 * Example module. Copy this shape for profiles, applications, matches, etc:
 * zod-validate the input, check role in preHandler, talk to the db, return.
 */

const createBody = z.object({
  sportId: z.string().uuid(),
  title: z.string().min(1),
  description: z.string().optional(),
  type: z.enum(['free', 'paid']),
  entryFee: z.number().int().nonnegative().optional(),
  currency: z.string().optional(),
});

export async function competitionsRoutes(app: FastifyInstance) {
  // Public: list open competitions.
  app.get('/competitions', async () => {
    return db
      .select()
      .from(competitions)
      .where(eq(competitions.status, 'open'))
      .orderBy(desc(competitions.createdAt));
  });

  // Admin only: create a competition.
  app.post('/competitions', { preHandler: app.requireRole('admin') }, async (req, reply) => {
    const body = parse(createBody, req.body);
    if (body.type === 'paid' && (!body.entryFee || body.entryFee <= 0)) {
      throw new AppError('paid competitions need a positive entryFee', 400);
    }
    const created = (
      await db
        .insert(competitions)
        .values({
          createdBy: req.user.sub,
          sportId: body.sportId,
          title: body.title,
          description: body.description,
          type: body.type,
          entryFee: body.type === 'paid' ? body.entryFee ?? 0 : 0,
          currency: body.currency ?? 'KZT',
          status: 'open',
        })
        .returning()
    )[0];
    return reply.code(201).send(created);
  });
}
