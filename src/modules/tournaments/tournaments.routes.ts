import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, count, desc, eq } from 'drizzle-orm';
import { parse } from '../../lib/validate';
import { AppError } from '../../lib/errors';
import { db } from '../../db/client';
import {
  sportProfiles,
  sports,
  tournamentRegistrations,
  tournaments,
  users,
} from '../../db/schema';

const idParam = z.object({ id: z.string().uuid() });
const regParams = z.object({ id: z.string().uuid(), userId: z.string().uuid() });

// All fields optional — an admin patches only what changes. `status` moves the
// tournament through its lifecycle and is validated against ALLOWED_TRANSITIONS.
const updateBody = z
  .object({
    title: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    type: z.enum(['free', 'paid']).optional(),
    location: z.string().min(1).optional(),
    city: z.string().nullable().optional(),
    startsAt: z.string().datetime().optional(),
    prizePool: z.number().int().nonnegative().optional(),
    entryFee: z.number().int().nonnegative().optional(),
    currency: z.string().optional(),
    bracketInfo: z.string().nullable().optional(),
    capacity: z.number().int().positive().nullable().optional(),
    minRating: z.number().int().nonnegative().nullable().optional(),
    maxRating: z.number().int().nonnegative().nullable().optional(),
    status: z.enum(['draft', 'open', 'closed', 'completed', 'cancelled']).optional(),
  })
  .refine(
    (b) =>
      b.minRating === undefined ||
      b.maxRating === undefined ||
      b.minRating === null ||
      b.maxRating === null ||
      b.minRating <= b.maxRating,
    { message: 'minRating must be <= maxRating', path: ['minRating'] },
  );

const addParticipantBody = z.object({ userId: z.string().uuid() });
const registrationStatusBody = z.object({ status: z.enum(['registered', 'withdrawn']) });

// Which status a tournament may move to from its current one.
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  draft: ['open', 'cancelled'],
  open: ['closed', 'cancelled'],
  closed: ['completed', 'open', 'cancelled'],
  completed: [],
  cancelled: [],
};

// Count of players currently holding a slot (status = registered).
async function registeredCount(tournamentId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(tournamentRegistrations)
    .where(
      and(
        eq(tournamentRegistrations.tournamentId, tournamentId),
        eq(tournamentRegistrations.status, 'registered'),
      ),
    );
  return row?.value ?? 0;
}

async function loadTournamentOr404(id: string) {
  const t = (
    await db.select().from(tournaments).where(eq(tournaments.id, id)).limit(1)
  )[0];
  if (!t) throw new AppError('tournament not found', 404);
  return t;
}

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

      // Capacity gate: only when a limit is set, and only for a new/returning
      // registered slot (re-registering after withdrawal counts as taking one).
      if (tournament.capacity !== null) {
        if ((await registeredCount(id)) >= tournament.capacity) {
          throw new AppError('tournament is full', 409);
        }
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

  // Public: a single tournament with its current registered count.
  app.get('/tournaments/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const tournament = await loadTournamentOr404(id);
    return { ...tournament, registeredCount: await registeredCount(id) };
  });

  // Authenticated player: withdraw yourself from a tournament.
  app.post('/tournaments/:id/withdraw', { preHandler: app.authenticate }, async (req) => {
    const { id } = parse(idParam, req.params);
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
    if (!existing || existing.status !== 'registered') {
      throw new AppError('you are not registered for this tournament', 404);
    }
    return (
      await db
        .update(tournamentRegistrations)
        .set({ status: 'withdrawn' })
        .where(eq(tournamentRegistrations.id, existing.id))
        .returning()
    )[0];
  });

  /* ---------------------------------------------------------------- admin -- */

  // Admin: list every tournament (any status), optionally filtered by status.
  app.get('/admin/tournaments', { preHandler: app.requireRole('admin') }, async (req) => {
    const { status } = parse(
      z.object({
        status: z.enum(['draft', 'open', 'closed', 'completed', 'cancelled']).optional(),
      }),
      req.query,
    );
    return db
      .select()
      .from(tournaments)
      .where(status ? eq(tournaments.status, status) : undefined)
      .orderBy(desc(tournaments.createdAt));
  });

  // Admin: edit a tournament and/or move it through its lifecycle.
  app.patch('/tournaments/:id', { preHandler: app.requireRole('admin') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(updateBody, req.body);
    const tournament = await loadTournamentOr404(id);

    // Validate the status transition, if a (different) status was requested.
    if (body.status && body.status !== tournament.status) {
      const allowed = ALLOWED_TRANSITIONS[tournament.status] ?? [];
      if (!allowed.includes(body.status)) {
        throw new AppError(
          `cannot change status from ${tournament.status} to ${body.status}`,
          409,
        );
      }
    }

    // Effective values after the patch, for cross-field validation.
    const effType = body.type ?? tournament.type;
    const effEntryFee = body.entryFee ?? tournament.entryFee;
    if (effType === 'paid' && (!effEntryFee || effEntryFee <= 0)) {
      throw new AppError('paid tournaments need a positive entryFee', 400);
    }
    const effMin = body.minRating !== undefined ? body.minRating : tournament.minRating;
    const effMax = body.maxRating !== undefined ? body.maxRating : tournament.maxRating;
    if (effMin !== null && effMax !== null && effMin > effMax) {
      throw new AppError('minRating must be <= maxRating', 400);
    }
    // Never shrink capacity below the players already registered.
    if (body.capacity !== undefined && body.capacity !== null) {
      const current = await registeredCount(id);
      if (body.capacity < current) {
        throw new AppError(
          `capacity cannot be below the current registered count (${current})`,
          409,
        );
      }
    }

    const set: Partial<typeof tournaments.$inferInsert> = {};
    if (body.title !== undefined) set.title = body.title;
    if (body.description !== undefined) set.description = body.description;
    if (body.type !== undefined) set.type = body.type;
    if (body.location !== undefined) set.location = body.location;
    if (body.city !== undefined) set.city = body.city;
    if (body.startsAt !== undefined) set.startsAt = new Date(body.startsAt);
    if (body.prizePool !== undefined) set.prizePool = body.prizePool;
    if (body.entryFee !== undefined) set.entryFee = body.entryFee;
    if (body.currency !== undefined) set.currency = body.currency;
    if (body.bracketInfo !== undefined) set.bracketInfo = body.bracketInfo;
    if (body.capacity !== undefined) set.capacity = body.capacity;
    if (body.minRating !== undefined) set.minRating = body.minRating;
    if (body.maxRating !== undefined) set.maxRating = body.maxRating;
    if (body.status !== undefined) set.status = body.status;
    if (effType === 'free') set.entryFee = 0; // free tournaments never carry a fee
    if (Object.keys(set).length === 0) {
      throw new AppError('no fields to update', 400);
    }

    return (
      await db.update(tournaments).set(set).where(eq(tournaments.id, id)).returning()
    )[0];
  });

  // Admin: delete a tournament. Only allowed while it has no registrations;
  // otherwise cancel it (PATCH status=cancelled) to preserve history.
  app.delete('/tournaments/:id', { preHandler: app.requireRole('admin') }, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    await loadTournamentOr404(id);
    const [row] = await db
      .select({ value: count() })
      .from(tournamentRegistrations)
      .where(eq(tournamentRegistrations.tournamentId, id));
    if ((row?.value ?? 0) > 0) {
      throw new AppError(
        'cannot delete a tournament that has registrations; cancel it instead',
        409,
      );
    }
    await db.delete(tournaments).where(eq(tournaments.id, id));
    return reply.code(204).send();
  });

  // Admin: view everyone registered for a tournament (name, email, per-sport
  // rating, status, when they registered). Optional ?status= filter.
  app.get(
    '/tournaments/:id/registrations',
    { preHandler: app.requireRole('admin') },
    async (req) => {
      const { id } = parse(idParam, req.params);
      const { status } = parse(
        z.object({ status: z.enum(['registered', 'withdrawn']).optional() }),
        req.query,
      );
      const tournament = await loadTournamentOr404(id);

      return db
        .select({
          registrationId: tournamentRegistrations.id,
          userId: users.id,
          name: users.name,
          email: users.email,
          status: tournamentRegistrations.status,
          rating: sportProfiles.rating,
          registeredAt: tournamentRegistrations.createdAt,
        })
        .from(tournamentRegistrations)
        .innerJoin(users, eq(users.id, tournamentRegistrations.userId))
        .leftJoin(
          sportProfiles,
          and(
            eq(sportProfiles.userId, tournamentRegistrations.userId),
            eq(sportProfiles.sportId, tournament.sportId),
          ),
        )
        .where(
          and(
            eq(tournamentRegistrations.tournamentId, id),
            status ? eq(tournamentRegistrations.status, status) : undefined,
          ),
        )
        .orderBy(desc(tournamentRegistrations.createdAt));
    },
  );

  // Admin: register a player on their behalf. Bypasses the open-status, rating
  // and capacity gates (admin override), but the player must have a profile in
  // the sport so the registration is consistent.
  app.post(
    '/tournaments/:id/registrations',
    { preHandler: app.requireRole('admin') },
    async (req, reply) => {
      const { id } = parse(idParam, req.params);
      const { userId } = parse(addParticipantBody, req.body);
      const tournament = await loadTournamentOr404(id);

      const user = (
        await db.select().from(users).where(eq(users.id, userId)).limit(1)
      )[0];
      if (!user) throw new AppError('user not found', 404);

      const profile = (
        await db
          .select()
          .from(sportProfiles)
          .where(
            and(
              eq(sportProfiles.userId, userId),
              eq(sportProfiles.sportId, tournament.sportId),
            ),
          )
          .limit(1)
      )[0];
      if (!profile) {
        throw new AppError('this user has no profile in the tournament sport', 400);
      }

      const existing = (
        await db
          .select()
          .from(tournamentRegistrations)
          .where(
            and(
              eq(tournamentRegistrations.tournamentId, id),
              eq(tournamentRegistrations.userId, userId),
            ),
          )
          .limit(1)
      )[0];
      if (existing && existing.status === 'registered') {
        throw new AppError('this user is already registered', 409);
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
              .values({ tournamentId: id, userId })
              .returning()
          )[0];

      return reply.code(201).send(registration);
    },
  );

  // Admin: change a participant's registration status (e.g. withdraw / reinstate).
  app.patch(
    '/tournaments/:id/registrations/:userId',
    { preHandler: app.requireRole('admin') },
    async (req) => {
      const { id, userId } = parse(regParams, req.params);
      const { status } = parse(registrationStatusBody, req.body);

      const existing = (
        await db
          .select()
          .from(tournamentRegistrations)
          .where(
            and(
              eq(tournamentRegistrations.tournamentId, id),
              eq(tournamentRegistrations.userId, userId),
            ),
          )
          .limit(1)
      )[0];
      if (!existing) throw new AppError('registration not found', 404);

      return (
        await db
          .update(tournamentRegistrations)
          .set({ status })
          .where(eq(tournamentRegistrations.id, existing.id))
          .returning()
      )[0];
    },
  );

  // Admin: remove a participant's registration entirely.
  app.delete(
    '/tournaments/:id/registrations/:userId',
    { preHandler: app.requireRole('admin') },
    async (req, reply) => {
      const { id, userId } = parse(regParams, req.params);
      const existing = (
        await db
          .select()
          .from(tournamentRegistrations)
          .where(
            and(
              eq(tournamentRegistrations.tournamentId, id),
              eq(tournamentRegistrations.userId, userId),
            ),
          )
          .limit(1)
      )[0];
      if (!existing) throw new AppError('registration not found', 404);

      await db
        .delete(tournamentRegistrations)
        .where(eq(tournamentRegistrations.id, existing.id));
      return reply.code(204).send();
    },
  );
}
