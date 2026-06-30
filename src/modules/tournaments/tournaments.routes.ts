import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { parse } from '../../lib/validate';
import { AppError } from '../../lib/errors';
import { db } from '../../db/client';
import {
  sportProfiles,
  sports,
  tournamentRegistrations,
  tournaments,
} from '../../db/schema';

const createBody = z
  .object({
    sportId: z.string().uuid(),
    title: z.string().min(1),
    description: z.string().optional(),
    type: z.enum(['free', 'paid']).default('free'),
    location: z.string().min(1),
    city: z.string().optional(),
    // ISO 8601 datetime, e.g. "2026-07-01T18:00:00Z".
    startsAt: z.string().datetime(),
    prizePool: z.number().int().nonnegative().optional(),
    entryFee: z.number().int().nonnegative().optional(),
    currency: z.string().optional(),
    bracketInfo: z.string().optional(),
    // Omit for no limit.
    capacity: z.number().int().positive().optional(),
    // Optional rating range. When omitted, anyone with a profile in the sport
    // can register. Omit either bound to leave that side open.
    minRating: z.number().int().nonnegative().optional(),
    maxRating: z.number().int().nonnegative().optional(),
  })
  .refine(
    (b) => b.minRating === undefined || b.maxRating === undefined || b.minRating <= b.maxRating,
    { message: 'minRating must be <= maxRating', path: ['minRating'] },
  );

export async function tournamentsRoutes(app: FastifyInstance) {
  // Public: list open tournaments.
  app.get('/tournaments', async () => {
    return db
      .select()
      .from(tournaments)
      .where(eq(tournaments.status, 'open'))
      .orderBy(desc(tournaments.startsAt));
  });

  // Admin only: create a tournament.
  app.post('/tournaments', { preHandler: app.requireRole('admin') }, async (req, reply) => {
    const body = parse(createBody, req.body);
    if (body.type === 'paid' && (!body.entryFee || body.entryFee <= 0)) {
      throw new AppError('paid tournaments need a positive entryFee', 400);
    }

    const sport = (
      await db.select().from(sports).where(eq(sports.id, body.sportId)).limit(1)
    )[0];
    if (!sport) {
      throw new AppError('sport not found', 404);
    }

    const created = (
      await db
        .insert(tournaments)
        .values({
          createdBy: req.user.sub,
          sportId: body.sportId,
          title: body.title,
          description: body.description,
          type: body.type,
          location: body.location,
          city: body.city,
          startsAt: new Date(body.startsAt),
          prizePool: body.prizePool ?? 0,
          entryFee: body.type === 'paid' ? body.entryFee ?? 0 : 0,
          currency: body.currency ?? 'KZT',
          bracketInfo: body.bracketInfo,
          capacity: body.capacity ?? null,
          minRating: body.minRating ?? null,
          maxRating: body.maxRating ?? null,
          status: 'open',
        })
        .returning()
    )[0];
    return reply.code(201).send(created);
  });

  // Authenticated player: register for a tournament. Requires a sport profile
  // in the tournament's sport, and a high-enough rating when minRating is set.
  app.post(
    '/tournaments/:id/register',
    { preHandler: app.authenticate },
    async (req, reply) => {
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params);

      const tournament = (
        await db.select().from(tournaments).where(eq(tournaments.id, id)).limit(1)
      )[0];
      if (!tournament) {
        throw new AppError('tournament not found', 404);
      }
      if (tournament.status !== 'open') {
        throw new AppError('tournament is not open for registration', 409);
      }

      const profile = (
        await db
          .select()
          .from(sportProfiles)
          .where(
            and(
              eq(sportProfiles.userId, req.user.sub),
              eq(sportProfiles.sportId, tournament.sportId),
            ),
          )
          .limit(1)
      )[0];
      if (!profile) {
        throw new AppError('you need a profile in this sport to register', 403);
      }

      if (tournament.minRating !== null || tournament.maxRating !== null) {
        if (profile.rating === null) {
          throw new AppError('your profile has no rating yet', 403);
        }
        if (tournament.minRating !== null && profile.rating < tournament.minRating) {
          throw new AppError(
            `your rating must be at least ${tournament.minRating} to register`,
            403,
          );
        }
        if (tournament.maxRating !== null && profile.rating > tournament.maxRating) {
          throw new AppError(
            `your rating must be at most ${tournament.maxRating} to register`,
            403,
          );
        }
      }

      const existing = (
        await db
          .select()
          .from(tournamentRegistrations)
          .where(
            and(
              eq(tournamentRegistrations.tournamentId, id),
              eq(tournamentRegistrations.userId, req.user.sub),
            ),
          )
          .limit(1)
      )[0];
      if (existing && existing.status === 'registered') {
        throw new AppError('you are already registered for this tournament', 409);
      }

      const registration = existing
        ? (
            await db
              .update(tournamentRegistrations)
              .set({ status: 'registered' })
              .where(eq(tournamentRegistrations.id, existing.id))
              .returning()
          )[0]
        : (
            await db
              .insert(tournamentRegistrations)
              .values({ tournamentId: id, userId: req.user.sub })
              .returning()
          )[0];

      return reply.code(201).send(registration);
    },
  );
}
