import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, count, desc, eq, inArray } from 'drizzle-orm';
import { parse } from '../../lib/validate';
import { AppError } from '../../lib/errors';
import { db } from '../../db/client';
import {
  registrationRemovals,
  sportProfiles,
  sports,
  teamMembers,
  teams,
  tournamentEntries,
  tournamentRegistrations,
  tournamentTeamRegistrationMembers,
  tournamentTeamRegistrations,
  tournaments,
  users,
} from '../../db/schema';
import { isValidCitySlug } from '../../lib/cities';
import {
  AGE_OPEN_MAX,
  AGE_OPEN_MIN,
  RATING_OPEN_MAX,
  RATING_OPEN_MIN,
  ageFromBirthDate,
  hasAgeBound,
  hasRatingBound,
} from '../../lib/eligibility';

const idParam = z.object({ id: z.string().uuid() });

// A tournament's city must be one of the canonical Kazakhstan city slugs
// (see src/lib/cities.ts). Stored as the slug; the frontend localises it.
const citySlug = z
  .string()
  .refine(isValidCitySlug, { message: 'unknown city' });
const regParams = z.object({ id: z.string().uuid(), userId: z.string().uuid() });

// All fields optional — an admin patches only what changes. `status` moves the
// tournament through its lifecycle and is validated against ALLOWED_TRANSITIONS.
const updateBody = z
  .object({
    title: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    type: z.enum(['free', 'paid']).optional(),
    location: z.string().min(1).optional(),
    city: citySlug.nullable().optional(),
    startsAt: z.string().datetime().optional(),
    prizePool: z.number().int().nonnegative().optional(),
    entryFee: z.number().int().nonnegative().optional(),
    currency: z.string().optional(),
    bracketInfo: z.string().nullable().optional(),
    // Roster size for team tournaments. participantType itself is immutable
    // after creation — solo vs team changes the whole registration model.
    teamSize: z.number().int().min(2).optional(),
    capacity: z.number().int().positive().nullable().optional(),
    minRating: z.number().int().nonnegative().optional(),
    maxRating: z.number().int().nonnegative().optional(),
    minAge: z.number().int().nonnegative().optional(),
    maxAge: z.number().int().nonnegative().optional(),
    status: z.enum(['draft', 'open', 'closed', 'completed', 'cancelled']).optional(),
  })
  .refine(
    (b) => b.minRating === undefined || b.maxRating === undefined || b.minRating <= b.maxRating,
    { message: 'minRating must be <= maxRating', path: ['minRating'] },
  )
  .refine(
    (b) => b.minAge === undefined || b.maxAge === undefined || b.minAge <= b.maxAge,
    { message: 'minAge must be <= maxAge', path: ['minAge'] },
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

// Count of competing units currently holding a slot (status = registered):
// players for solo tournaments, teams for team tournaments.
async function registeredCount(
  tournamentId: string,
  participantType: 'solo' | 'team',
): Promise<number> {
  const source =
    participantType === 'team' ? tournamentTeamRegistrations : tournamentRegistrations;
  const [row] = await db
    .select({ value: count() })
    .from(source)
    .where(and(eq(source.tournamentId, tournamentId), eq(source.status, 'registered')));
  return row?.value ?? 0;
}

// Recompute the registered unit count from the source table and persist it on
// the tournament's `occupiedPlaces` column so it stays authoritative after any
// registration change. Returns the freshly computed count.
async function syncOccupiedPlaces(
  tournamentId: string,
  participantType: 'solo' | 'team',
): Promise<number> {
  const value = await registeredCount(tournamentId, participantType);
  await db
    .update(tournaments)
    .set({ occupiedPlaces: value })
    .where(eq(tournaments.id, tournamentId));
  return value;
}

// Withdraw every currently-registered player who no longer fits the given age
// range, and record each removal in `registration_removals` so they can be
// notified. A player with no birth date can't be verified against the range and
// is treated as ineligible ('age_unknown'). Returns the removed players (with
// contact fields) for the response. No-op when the range is fully open.
async function enforceAgeLimit(tournamentId: string, minAge: number, maxAge: number) {
  if (!hasAgeBound(minAge, maxAge)) return [];

  const registered = await db
    .select({
      regId: tournamentRegistrations.id,
      userId: users.id,
      name: users.name,
      email: users.email,
      birthDate: users.birthDate,
    })
    .from(tournamentRegistrations)
    .innerJoin(users, eq(users.id, tournamentRegistrations.userId))
    .where(
      and(
        eq(tournamentRegistrations.tournamentId, tournamentId),
        eq(tournamentRegistrations.status, 'registered'),
      ),
    );

  const now = new Date();
  const removed = registered
    .map((r) => {
      if (!r.birthDate) return { ...r, age: null as number | null, reason: 'age_unknown' };
      const age = ageFromBirthDate(r.birthDate, now);
      if (age < minAge) return { ...r, age, reason: 'age_too_low' };
      if (age > maxAge) return { ...r, age, reason: 'age_too_high' };
      return null;
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  if (removed.length === 0) return [];

  await db.transaction(async (tx) => {
    await tx
      .update(tournamentRegistrations)
      .set({ status: 'withdrawn' })
      .where(
        inArray(
          tournamentRegistrations.id,
          removed.map((r) => r.regId),
        ),
      );
    await tx.insert(registrationRemovals).values(
      removed.map((r) => ({
        tournamentId,
        userId: r.userId,
        reason: r.reason,
        age: r.age,
        minAge,
        maxAge,
      })),
    );
  });
  // Age enforcement only touches solo registrations, so the unit count here is
  // always the solo one.
  await syncOccupiedPlaces(tournamentId, 'solo');

  return removed.map(({ userId, name, email, age, reason }) => ({
    userId,
    name,
    email,
    age,
    reason,
  }));
}

// A user's registration row for a tournament, if any (either status).
async function findRegistration(tournamentId: string, userId: string) {
  const [row] = await db
    .select()
    .from(tournamentRegistrations)
    .where(
      and(
        eq(tournamentRegistrations.tournamentId, tournamentId),
        eq(tournamentRegistrations.userId, userId),
      ),
    )
    .limit(1);
  return row;
}

// A user's profile in a sport, if any.
async function findSportProfile(userId: string, sportId: string) {
  const [row] = await db
    .select()
    .from(sportProfiles)
    .where(and(eq(sportProfiles.userId, userId), eq(sportProfiles.sportId, sportId)))
    .limit(1);
  return row;
}

/**
 * Take (or retake) a slot atomically. Locks the tournament row so two
 * concurrent registrations can't both pass the capacity check and overbook,
 * writes the registration, and recomputes `occupiedPlaces` — all in one
 * transaction.
 *
 * `existingId` reactivates that (withdrawn) row instead of inserting.
 * `enforceCapacity` is on for the player flow; admins bypass the limit.
 */
async function registerAtomically(opts: {
  tournamentId: string;
  userId: string;
  existingId?: string;
  enforceCapacity: boolean;
}) {
  return db.transaction(async (tx) => {
    const [t] = await tx
      .select()
      .from(tournaments)
      .where(eq(tournaments.id, opts.tournamentId))
      .for('update');
    if (!t) throw new AppError('tournament not found', 404);

    if (opts.enforceCapacity && t.capacity !== null) {
      const [row] = await tx
        .select({ value: count() })
        .from(tournamentRegistrations)
        .where(
          and(
            eq(tournamentRegistrations.tournamentId, opts.tournamentId),
            eq(tournamentRegistrations.status, 'registered'),
          ),
        );
      if ((row?.value ?? 0) >= t.capacity) {
        throw new AppError('no empty places left in this tournament', 409, 'tournament_full');
      }
    }

    const registration = opts.existingId
      ? (
          await tx
            .update(tournamentRegistrations)
            .set({ status: 'registered' })
            .where(eq(tournamentRegistrations.id, opts.existingId))
            .returning()
        )[0]
      : (
          await tx
            .insert(tournamentRegistrations)
            .values({ tournamentId: opts.tournamentId, userId: opts.userId })
            .returning()
        )[0];

    // Recompute from the source table rather than incrementing, so the value
    // always converges even if it had drifted.
    const [fresh] = await tx
      .select({ value: count() })
      .from(tournamentRegistrations)
      .where(
        and(
          eq(tournamentRegistrations.tournamentId, opts.tournamentId),
          eq(tournamentRegistrations.status, 'registered'),
        ),
      );
    await tx
      .update(tournaments)
      .set({ occupiedPlaces: fresh?.value ?? 0 })
      .where(eq(tournaments.id, opts.tournamentId));

    return registration;
  });
}

/**
 * Team counterpart of registerAtomically: locks the tournament row, re-checks
 * team capacity, writes (or reactivates) the team registration and freezes the
 * roster snapshot — all in one transaction. The snapshot's UQ
 * (tournament_id, user_id) is the race-proof backstop against one player
 * entering the same tournament through two different teams.
 */
async function registerTeamAtomically(opts: {
  tournamentId: string;
  teamId: string;
  memberIds: string[];
  existingId?: string;
  enforceCapacity: boolean;
}) {
  try {
    return await db.transaction(async (tx) => {
      const [t] = await tx
        .select()
        .from(tournaments)
        .where(eq(tournaments.id, opts.tournamentId))
        .for('update');
      if (!t) throw new AppError('tournament not found', 404);

      if (opts.enforceCapacity && t.capacity !== null) {
        const [row] = await tx
          .select({ value: count() })
          .from(tournamentTeamRegistrations)
          .where(
            and(
              eq(tournamentTeamRegistrations.tournamentId, opts.tournamentId),
              eq(tournamentTeamRegistrations.status, 'registered'),
            ),
          );
        if ((row?.value ?? 0) >= t.capacity) {
          throw new AppError('no empty places left in this tournament', 409, 'tournament_full');
        }
      }

      const registration = opts.existingId
        ? (
            await tx
              .update(tournamentTeamRegistrations)
              .set({ status: 'registered' })
              .where(eq(tournamentTeamRegistrations.id, opts.existingId))
              .returning()
          )[0]
        : (
            await tx
              .insert(tournamentTeamRegistrations)
              .values({ tournamentId: opts.tournamentId, teamId: opts.teamId })
              .returning()
          )[0];

      // Freeze the roster. Withdrawn re-registration starts a fresh snapshot.
      await tx
        .delete(tournamentTeamRegistrationMembers)
        .where(eq(tournamentTeamRegistrationMembers.registrationId, registration.id));
      await tx.insert(tournamentTeamRegistrationMembers).values(
        opts.memberIds.map((userId) => ({
          registrationId: registration.id,
          tournamentId: opts.tournamentId,
          userId,
        })),
      );

      const [fresh] = await tx
        .select({ value: count() })
        .from(tournamentTeamRegistrations)
        .where(
          and(
            eq(tournamentTeamRegistrations.tournamentId, opts.tournamentId),
            eq(tournamentTeamRegistrations.status, 'registered'),
          ),
        );
      await tx
        .update(tournaments)
        .set({ occupiedPlaces: fresh?.value ?? 0 })
        .where(eq(tournaments.id, opts.tournamentId));

      return registration;
    });
  } catch (err) {
    // Unique-violation backstop: a concurrent registration snapshotted one of
    // these players first. The friendly pre-check reports names; this only
    // fires on the race the pre-check can't see.
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: string }).code === '23505'
    ) {
      throw new AppError(
        'a player on this roster is already registered in this tournament with another team',
        409,
        'player_already_in_tournament',
      );
    }
    throw err;
  }
}

// Slots still open on a tournament: null when it has no capacity limit,
// otherwise capacity minus the players holding a slot (never negative).
type Tournament = typeof tournaments.$inferSelect;
function withFreePlaces<T extends Tournament>(t: T) {
  const freePlaces =
    t.capacity === null ? null : Math.max(0, t.capacity - t.occupiedPlaces);
  return { ...t, freePlaces };
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
    city: citySlug.optional(),
    // ISO 8601 datetime, e.g. "2026-07-01T18:00:00Z".
    startsAt: z.string().datetime(),
    prizePool: z.number().int().nonnegative().optional(),
    entryFee: z.number().int().nonnegative().optional(),
    currency: z.string().optional(),
    bracketInfo: z.string().optional(),
    // solo = 1v1 (players register themselves); team = teams register via
    // their captain. teamSize is required for team tournaments and forbidden
    // for solo ones.
    participantType: z.enum(['solo', 'team']).default('solo'),
    teamSize: z.number().int().min(2).optional(),
    // Omit for no limit. Counts players for solo, teams for team tournaments.
    capacity: z.number().int().positive().optional(),
    // Inclusive rating range. Defaults span the full range, so omitting both
    // lets anyone with a profile in the sport register.
    minRating: z.number().int().nonnegative().default(RATING_OPEN_MIN),
    maxRating: z.number().int().nonnegative().default(RATING_OPEN_MAX),
    // Inclusive age range. Defaults mean no age restriction.
    minAge: z.number().int().nonnegative().default(AGE_OPEN_MIN),
    maxAge: z.number().int().nonnegative().default(AGE_OPEN_MAX),
  })
  .refine((b) => b.minRating <= b.maxRating, {
    message: 'minRating must be <= maxRating',
    path: ['minRating'],
  })
  .refine((b) => b.minAge <= b.maxAge, {
    message: 'minAge must be <= maxAge',
    path: ['minAge'],
  })
  .refine((b) => (b.participantType === 'team') === (b.teamSize !== undefined), {
    message: 'teamSize is required for team tournaments and not allowed for solo ones',
    path: ['teamSize'],
  });

export async function tournamentsRoutes(app: FastifyInstance) {
  // Public: list open tournaments, each with its free-slot count. Optionally
  // narrow to a single city with ?city=<slug> (see src/lib/cities.ts).
  app.get('/tournaments', async (req) => {
    const { city } = parse(
      z.object({ city: citySlug.optional() }),
      req.query,
    );
    const rows = await db
      .select()
      .from(tournaments)
      .where(
        and(
          eq(tournaments.status, 'open'),
          city ? eq(tournaments.city, city) : undefined,
        ),
      )
      .orderBy(desc(tournaments.startsAt));
    return rows.map(withFreePlaces);
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
          participantType: body.participantType,
          teamSize: body.teamSize ?? null,
          capacity: body.capacity ?? null,
          minRating: body.minRating,
          maxRating: body.maxRating,
          minAge: body.minAge,
          maxAge: body.maxAge,
          status: 'open',
        })
        .returning()
    )[0];
    req.log.info(
      {
        tournamentId: created.id,
        sportId: created.sportId,
        participantType: created.participantType,
        teamSize: created.teamSize,
        byUserId: req.user.sub,
      },
      'tournament created',
    );
    return reply.code(201).send(created);
  });

  // Authenticated player: register for a tournament. Requires a sport profile
  // in the tournament's sport, and a high-enough rating when minRating is set.
  app.post(
    '/tournaments/:id/register',
    { preHandler: app.authenticate },
    async (req, reply) => {
      const { id } = parse(idParam, req.params);

      const tournament = await loadTournamentOr404(id);
      if (tournament.participantType === 'team') {
        throw new AppError(
          'this is a team tournament; a team captain must register the team',
          409,
          'team_tournament',
        );
      }
      if (tournament.status !== 'open') {
        throw new AppError(
          'tournament is not open for registration',
          409,
          'tournament_not_open',
        );
      }

      const profile = await findSportProfile(req.user.sub, tournament.sportId);
      if (!profile) {
        throw new AppError(
          'you need a profile in this sport to register',
          403,
          'no_sport_profile',
        );
      }

      // Rating gate. Bounds default to the full range, so a tournament without
      // a real bound accepts any rating (including an unrated profile).
      if (hasRatingBound(tournament.minRating, tournament.maxRating)) {
        if (profile.rating === null) {
          throw new AppError('your profile has no rating yet', 403, 'no_rating');
        }
        if (profile.rating < tournament.minRating) {
          throw new AppError(
            `your rating must be at least ${tournament.minRating} to register`,
            403,
            'rating_too_low',
          );
        }
        if (profile.rating > tournament.maxRating) {
          throw new AppError(
            `your rating must be at most ${tournament.maxRating} to register`,
            403,
            'rating_too_high',
          );
        }
      }

      // Age gate. Only enforced when the tournament sets a real age bound; the
      // player's birth date is captured at Google sign-in.
      if (hasAgeBound(tournament.minAge, tournament.maxAge)) {
        const player = (
          await db
            .select({ birthDate: users.birthDate })
            .from(users)
            .where(eq(users.id, req.user.sub))
            .limit(1)
        )[0];
        if (!player?.birthDate) {
          throw new AppError(
            'you must set your birth date to register for this tournament',
            403,
            'birthdate_required',
          );
        }
        const age = ageFromBirthDate(player.birthDate, new Date());
        if (age < tournament.minAge) {
          throw new AppError(
            `you must be at least ${tournament.minAge} years old to register`,
            403,
            'age_too_low',
          );
        }
        if (age > tournament.maxAge) {
          throw new AppError(
            `you must be at most ${tournament.maxAge} years old to register`,
            403,
            'age_too_high',
          );
        }
      }

      const existing = await findRegistration(id, req.user.sub);
      if (existing && existing.status === 'registered') {
        throw new AppError(
          'you are already registered for this tournament',
          409,
          'already_registered',
        );
      }

      // Capacity gate (only when a limit is set) + the write happen inside one
      // transaction with the tournament row locked, so concurrent registrations
      // for the last slot can't overbook. Re-registering after withdrawal
      // counts as taking a slot again.
      const registration = await registerAtomically({
        tournamentId: id,
        userId: req.user.sub,
        existingId: existing?.id,
        enforceCapacity: true,
      });

      req.log.info(
        { tournamentId: id, userId: req.user.sub, reactivated: Boolean(existing) },
        'player registered for tournament',
      );
      return reply.code(201).send(registration);
    },
  );

  // Authenticated captain: register your team for a team tournament with an
  // explicit roster of exactly `teamSize` active members. The roster is frozen
  // as a snapshot; later team changes don't affect this tournament. A player
  // already snapshotted for this tournament (via any team) blocks the roster.
  app.post(
    '/tournaments/:id/register-team',
    { preHandler: app.authenticate },
    async (req, reply) => {
      const { id } = parse(idParam, req.params);
      const { teamId, memberIds } = parse(
        z.object({
          teamId: z.string().uuid(),
          memberIds: z.array(z.string().uuid()).min(1),
        }),
        req.body,
      );

      const tournament = await loadTournamentOr404(id);
      if (tournament.participantType !== 'team') {
        throw new AppError(
          'this is a solo tournament; register yourself instead',
          409,
          'solo_tournament',
        );
      }
      if (tournament.status !== 'open') {
        throw new AppError(
          'tournament is not open for registration',
          409,
          'tournament_not_open',
        );
      }

      const [team] = await db.select().from(teams).where(eq(teams.id, teamId)).limit(1);
      if (!team) throw new AppError('team not found', 404);
      if (team.sportId !== tournament.sportId) {
        throw new AppError(
          'this team plays a different sport than the tournament',
          400,
          'sport_mismatch',
        );
      }

      const [captain] = await db
        .select()
        .from(teamMembers)
        .where(
          and(
            eq(teamMembers.teamId, teamId),
            eq(teamMembers.userId, req.user.sub),
            eq(teamMembers.status, 'active'),
            eq(teamMembers.role, 'captain'),
          ),
        )
        .limit(1);
      if (!captain) {
        throw new AppError('only the team captain can register the team', 403, 'not_captain');
      }

      const [existing] = await db
        .select()
        .from(tournamentTeamRegistrations)
        .where(
          and(
            eq(tournamentTeamRegistrations.tournamentId, id),
            eq(tournamentTeamRegistrations.teamId, teamId),
          ),
        )
        .limit(1);
      if (existing && existing.status === 'registered') {
        throw new AppError(
          'your team is already registered for this tournament',
          409,
          'already_registered',
        );
      }

      const roster = [...new Set(memberIds)];
      if (roster.length !== memberIds.length) {
        throw new AppError('memberIds contains duplicates', 400);
      }
      if (tournament.teamSize !== null && roster.length !== tournament.teamSize) {
        throw new AppError(
          `this tournament requires a roster of exactly ${tournament.teamSize} players`,
          400,
          'wrong_roster_size',
        );
      }

      // Every roster player must be an active member of the team.
      const activeMembers = await db
        .select({ userId: teamMembers.userId })
        .from(teamMembers)
        .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.status, 'active')));
      const activeIds = new Set(activeMembers.map((m) => m.userId));
      const notInTeam = roster.filter((uid) => !activeIds.has(uid));
      if (notInTeam.length > 0) {
        throw new AppError(
          'some roster players are not active members of this team',
          400,
          'not_team_member',
        );
      }

      // Per-member eligibility: sport profile, then rating and age gates —
      // the same order the solo flow uses.
      const rosterUsers = await db
        .select({
          userId: users.id,
          name: users.name,
          email: users.email,
          birthDate: users.birthDate,
          rating: sportProfiles.rating,
          profileId: sportProfiles.id,
        })
        .from(users)
        .leftJoin(
          sportProfiles,
          and(eq(sportProfiles.userId, users.id), eq(sportProfiles.sportId, tournament.sportId)),
        )
        .where(inArray(users.id, roster));

      const noProfile = rosterUsers.filter((u) => !u.profileId);
      if (noProfile.length > 0) {
        throw new AppError(
          `these players need a profile in this sport: ${noProfile
            .map((u) => u.name ?? u.email)
            .join(', ')}`,
          403,
          'member_no_sport_profile',
        );
      }

      if (hasRatingBound(tournament.minRating, tournament.maxRating)) {
        const outOfRange = rosterUsers.filter(
          (u) =>
            u.rating === null ||
            u.rating < tournament.minRating ||
            u.rating > tournament.maxRating,
        );
        if (outOfRange.length > 0) {
          throw new AppError(
            `these players do not fit the rating range ${tournament.minRating}–${tournament.maxRating}: ${outOfRange
              .map((u) => u.name ?? u.email)
              .join(', ')}`,
            403,
            'member_rating_out_of_range',
          );
        }
      }

      if (hasAgeBound(tournament.minAge, tournament.maxAge)) {
        const now = new Date();
        const outOfAge = rosterUsers.filter((u) => {
          if (!u.birthDate) return true;
          const age = ageFromBirthDate(u.birthDate, now);
          return age < tournament.minAge || age > tournament.maxAge;
        });
        if (outOfAge.length > 0) {
          throw new AppError(
            `these players do not fit the age range ${tournament.minAge}–${tournament.maxAge}: ${outOfAge
              .map((u) => u.name ?? u.email)
              .join(', ')}`,
            403,
            'member_age_out_of_range',
          );
        }
      }

      // Friendly cross-team exclusivity check: nobody on the roster may already
      // be snapshotted into this tournament with any team. The UQ constraint
      // inside registerTeamAtomically is the race-proof backstop.
      const alreadyIn = await db
        .select({ userId: tournamentTeamRegistrationMembers.userId })
        .from(tournamentTeamRegistrationMembers)
        .where(
          and(
            eq(tournamentTeamRegistrationMembers.tournamentId, id),
            inArray(tournamentTeamRegistrationMembers.userId, roster),
          ),
        );
      if (alreadyIn.length > 0) {
        const takenIds = new Set(alreadyIn.map((r) => r.userId));
        const names = rosterUsers
          .filter((u) => takenIds.has(u.userId))
          .map((u) => u.name ?? u.email);
        throw new AppError(
          `already registered in this tournament with another team: ${names.join(', ')}`,
          409,
          'player_already_in_tournament',
        );
      }

      const registration = await registerTeamAtomically({
        tournamentId: id,
        teamId,
        memberIds: roster,
        existingId: existing?.id,
        enforceCapacity: true,
      });

      req.log.info(
        {
          tournamentId: id,
          teamId,
          registrationId: registration.id,
          rosterSize: roster.length,
          byUserId: req.user.sub,
          reactivated: Boolean(existing),
        },
        'team registered for tournament',
      );
      return reply.code(201).send(registration);
    },
  );

  // Authenticated captain: withdraw your team. Frees the roster players to
  // enter this tournament with another team. Blocked once the bracket exists.
  app.post(
    '/tournaments/:id/withdraw-team',
    { preHandler: app.authenticate },
    async (req) => {
      const { id } = parse(idParam, req.params);
      const { teamId } = parse(z.object({ teamId: z.string().uuid() }), req.body);
      const tournament = await loadTournamentOr404(id);

      const [captain] = await db
        .select()
        .from(teamMembers)
        .where(
          and(
            eq(teamMembers.teamId, teamId),
            eq(teamMembers.userId, req.user.sub),
            eq(teamMembers.status, 'active'),
            eq(teamMembers.role, 'captain'),
          ),
        )
        .limit(1);
      if (!captain) {
        throw new AppError('only the team captain can withdraw the team', 403, 'not_captain');
      }

      const [existing] = await db
        .select()
        .from(tournamentTeamRegistrations)
        .where(
          and(
            eq(tournamentTeamRegistrations.tournamentId, id),
            eq(tournamentTeamRegistrations.teamId, teamId),
          ),
        )
        .limit(1);
      if (!existing || existing.status !== 'registered') {
        throw new AppError('your team is not registered for this tournament', 404);
      }

      const [entry] = await db
        .select({ id: tournamentEntries.id })
        .from(tournamentEntries)
        .where(eq(tournamentEntries.teamRegistrationId, existing.id))
        .limit(1);
      if (entry) {
        throw new AppError(
          'the bracket has been generated; withdrawal is closed',
          409,
          'bracket_generated',
        );
      }

      const withdrawn = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(tournamentTeamRegistrations)
          .set({ status: 'withdrawn' })
          .where(eq(tournamentTeamRegistrations.id, existing.id))
          .returning();
        // Drop the snapshot so these players may enter with another team.
        await tx
          .delete(tournamentTeamRegistrationMembers)
          .where(eq(tournamentTeamRegistrationMembers.registrationId, existing.id));
        return row;
      });
      await syncOccupiedPlaces(id, tournament.participantType);

      req.log.info(
        { tournamentId: id, teamId, byUserId: req.user.sub },
        'team withdrawn from tournament',
      );
      return withdrawn;
    },
  );

  // Public: a single tournament with its current registered count and how many
  // slots are still free (null when the tournament has no capacity limit).
  app.get('/tournaments/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const tournament = await loadTournamentOr404(id);
    return { ...withFreePlaces(tournament), registeredCount: tournament.occupiedPlaces };
  });

  // Authenticated player: withdraw yourself from a tournament.
  app.post('/tournaments/:id/withdraw', { preHandler: app.authenticate }, async (req) => {
    const { id } = parse(idParam, req.params);
    const existing = await findRegistration(id, req.user.sub);
    if (!existing || existing.status !== 'registered') {
      throw new AppError('you are not registered for this tournament', 404);
    }
    const withdrawn = (
      await db
        .update(tournamentRegistrations)
        .set({ status: 'withdrawn' })
        .where(eq(tournamentRegistrations.id, existing.id))
        .returning()
    )[0];
    await syncOccupiedPlaces(id, 'solo');
    req.log.info({ tournamentId: id, userId: req.user.sub }, 'player withdrew from tournament');
    return withdrawn;
  });

  // Authenticated player: the tournaments you're registered for, split into
  // `upcoming` (still to happen) and `past` (already played — your match
  // history). A tournament counts as past when it's completed or its start time
  // has passed; cancelled tournaments are excluded from both.
  app.get('/me/tournaments', { preHandler: app.authenticate }, async (req) => {
    const soloRows = await db
      .select({
        tournament: tournaments,
        sportName: sports.name,
        sportSlug: sports.slug,
        registeredAt: tournamentRegistrations.createdAt,
      })
      .from(tournamentRegistrations)
      .innerJoin(tournaments, eq(tournaments.id, tournamentRegistrations.tournamentId))
      .innerJoin(sports, eq(sports.id, tournaments.sportId))
      .where(
        and(
          eq(tournamentRegistrations.userId, req.user.sub),
          eq(tournamentRegistrations.status, 'registered'),
        ),
      )
      .orderBy(desc(tournaments.startsAt));

    // Team tournaments the user is snapshotted into (via whichever team).
    const teamRows = await db
      .select({
        tournament: tournaments,
        sportName: sports.name,
        sportSlug: sports.slug,
        registeredAt: tournamentTeamRegistrations.createdAt,
        teamId: teams.id,
        teamName: teams.name,
      })
      .from(tournamentTeamRegistrationMembers)
      .innerJoin(
        tournamentTeamRegistrations,
        eq(tournamentTeamRegistrations.id, tournamentTeamRegistrationMembers.registrationId),
      )
      .innerJoin(teams, eq(teams.id, tournamentTeamRegistrations.teamId))
      .innerJoin(tournaments, eq(tournaments.id, tournamentTeamRegistrations.tournamentId))
      .innerJoin(sports, eq(sports.id, tournaments.sportId))
      .where(
        and(
          eq(tournamentTeamRegistrationMembers.userId, req.user.sub),
          eq(tournamentTeamRegistrations.status, 'registered'),
        ),
      )
      .orderBy(desc(tournaments.startsAt));

    const rows = [
      ...soloRows.map((r) => ({ ...r, teamId: null as string | null, teamName: null as string | null })),
      ...teamRows,
    ].sort((a, b) => b.tournament.startsAt.getTime() - a.tournament.startsAt.getTime());

    const now = new Date();
    const upcoming: unknown[] = [];
    const past: unknown[] = [];
    for (const row of rows) {
      const t = row.tournament;
      if (t.status === 'cancelled') continue;
      const entry = {
        ...withFreePlaces(t),
        sportName: row.sportName,
        sportSlug: row.sportSlug,
        registeredAt: row.registeredAt,
        teamId: row.teamId,
        teamName: row.teamName,
      };
      const isPast = t.status === 'completed' || t.startsAt < now;
      (isPast ? past : upcoming).push(entry);
    }
    // Rows come back newest-first (right for past history); flip `upcoming` so
    // the soonest tournament leads.
    upcoming.reverse();
    return { upcoming, past };
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
    const rows = await db
      .select()
      .from(tournaments)
      .where(status ? eq(tournaments.status, status) : undefined)
      .orderBy(desc(tournaments.createdAt));
    return rows.map(withFreePlaces);
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
    const effMin = body.minRating ?? tournament.minRating;
    const effMax = body.maxRating ?? tournament.maxRating;
    if (effMin > effMax) {
      throw new AppError('minRating must be <= maxRating', 400);
    }
    const effMinAge = body.minAge ?? tournament.minAge;
    const effMaxAge = body.maxAge ?? tournament.maxAge;
    if (effMinAge > effMaxAge) {
      throw new AppError('minAge must be <= maxAge', 400);
    }
    // teamSize only applies to team tournaments and is frozen once any team
    // holds a slot (their snapshots were validated against the old size).
    if (body.teamSize !== undefined) {
      if (tournament.participantType !== 'team') {
        throw new AppError('teamSize only applies to team tournaments', 400);
      }
      const current = await registeredCount(id, 'team');
      if (current > 0) {
        throw new AppError(
          'cannot change teamSize while teams are registered',
          409,
        );
      }
    }
    // Never shrink capacity below the units already registered.
    if (body.capacity !== undefined && body.capacity !== null) {
      const current = await registeredCount(id, tournament.participantType);
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
    if (body.teamSize !== undefined) set.teamSize = body.teamSize;
    if (body.capacity !== undefined) set.capacity = body.capacity;
    if (body.minRating !== undefined) set.minRating = body.minRating;
    if (body.maxRating !== undefined) set.maxRating = body.maxRating;
    if (body.minAge !== undefined) set.minAge = body.minAge;
    if (body.maxAge !== undefined) set.maxAge = body.maxAge;
    if (body.status !== undefined) set.status = body.status;
    if (effType === 'free') set.entryFee = 0; // free tournaments never carry a fee
    if (Object.keys(set).length === 0) {
      throw new AppError('no fields to update', 400);
    }

    const updated = (
      await db.update(tournaments).set(set).where(eq(tournaments.id, id)).returning()
    )[0];

    // If the age limit changed, auto-withdraw any registered player who no
    // longer fits it and queue them for notification. `removed` lists who was
    // dropped (empty when nothing changed or nobody was affected).
    const ageChanged = body.minAge !== undefined || body.maxAge !== undefined;
    const removed = ageChanged
      ? await enforceAgeLimit(id, effMinAge, effMaxAge)
      : [];

    req.log.info(
      { tournamentId: id, byUserId: req.user.sub, fields: Object.keys(set), removedCount: removed.length },
      'tournament updated',
    );
    return { ...updated, removed };
  });

  // Admin: delete a tournament. Only allowed while it has no registrations;
  // otherwise cancel it (PATCH status=cancelled) to preserve history.
  app.delete('/tournaments/:id', { preHandler: app.requireRole('admin') }, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    await loadTournamentOr404(id);
    const [solo] = await db
      .select({ value: count() })
      .from(tournamentRegistrations)
      .where(eq(tournamentRegistrations.tournamentId, id));
    const [team] = await db
      .select({ value: count() })
      .from(tournamentTeamRegistrations)
      .where(eq(tournamentTeamRegistrations.tournamentId, id));
    if ((solo?.value ?? 0) + (team?.value ?? 0) > 0) {
      throw new AppError(
        'cannot delete a tournament that has registrations; cancel it instead',
        409,
      );
    }
    await db.delete(tournaments).where(eq(tournaments.id, id));
    req.log.info({ tournamentId: id, byAdmin: req.user.sub }, 'tournament deleted');
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

  // Admin: the team registrations of a team tournament, each with its frozen
  // roster snapshot. Optional ?status= filter.
  app.get(
    '/tournaments/:id/team-registrations',
    { preHandler: app.requireRole('admin') },
    async (req) => {
      const { id } = parse(idParam, req.params);
      const { status } = parse(
        z.object({ status: z.enum(['registered', 'withdrawn']).optional() }),
        req.query,
      );
      await loadTournamentOr404(id);

      const regs = await db
        .select({
          registrationId: tournamentTeamRegistrations.id,
          teamId: teams.id,
          teamName: teams.name,
          status: tournamentTeamRegistrations.status,
          registeredAt: tournamentTeamRegistrations.createdAt,
        })
        .from(tournamentTeamRegistrations)
        .innerJoin(teams, eq(teams.id, tournamentTeamRegistrations.teamId))
        .where(
          and(
            eq(tournamentTeamRegistrations.tournamentId, id),
            status ? eq(tournamentTeamRegistrations.status, status) : undefined,
          ),
        )
        .orderBy(desc(tournamentTeamRegistrations.createdAt));

      return Promise.all(
        regs.map(async (reg) => {
          const roster = await db
            .select({
              userId: users.id,
              name: users.name,
              email: users.email,
            })
            .from(tournamentTeamRegistrationMembers)
            .innerJoin(users, eq(users.id, tournamentTeamRegistrationMembers.userId))
            .where(eq(tournamentTeamRegistrationMembers.registrationId, reg.registrationId));
          return { ...reg, roster };
        }),
      );
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
      if (tournament.participantType === 'team') {
        throw new AppError(
          'this is a team tournament; players enter through team registrations',
          409,
          'team_tournament',
        );
      }

      const user = (
        await db.select().from(users).where(eq(users.id, userId)).limit(1)
      )[0];
      if (!user) throw new AppError('user not found', 404);

      const profile = await findSportProfile(userId, tournament.sportId);
      if (!profile) {
        throw new AppError('this user has no profile in the tournament sport', 400);
      }

      const existing = await findRegistration(id, userId);
      if (existing && existing.status === 'registered') {
        throw new AppError('this user is already registered', 409);
      }

      // Same atomic write as the player flow, minus the capacity gate (admin
      // override).
      const registration = await registerAtomically({
        tournamentId: id,
        userId,
        existingId: existing?.id,
        enforceCapacity: false,
      });

      req.log.info(
        { tournamentId: id, userId, byAdmin: req.user.sub },
        'admin registered player for tournament',
      );
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

      const existing = await findRegistration(id, userId);
      if (!existing) throw new AppError('registration not found', 404);

      const updated = (
        await db
          .update(tournamentRegistrations)
          .set({ status })
          .where(eq(tournamentRegistrations.id, existing.id))
          .returning()
      )[0];
      await syncOccupiedPlaces(id, 'solo');
      req.log.info(
        { tournamentId: id, userId, status, byAdmin: req.user.sub },
        'admin changed registration status',
      );
      return updated;
    },
  );

  // Admin: remove a participant's registration entirely.
  app.delete(
    '/tournaments/:id/registrations/:userId',
    { preHandler: app.requireRole('admin') },
    async (req, reply) => {
      const { id, userId } = parse(regParams, req.params);
      const existing = await findRegistration(id, userId);
      if (!existing) throw new AppError('registration not found', 404);

      await db
        .delete(tournamentRegistrations)
        .where(eq(tournamentRegistrations.id, existing.id));
      await syncOccupiedPlaces(id, 'solo');
      req.log.info(
        { tournamentId: id, userId, byAdmin: req.user.sub },
        'admin deleted registration',
      );
      return reply.code(204).send();
    },
  );

  // Admin: the notification queue of players auto-removed by an age-limit
  // change. Defaults to those not yet notified; pass ?notified=true to see all
  // handled ones, or ?tournamentId= to scope to one tournament. Includes name
  // and email so you can reach them on whatever channel you use.
  app.get(
    '/admin/removed-registrations',
    { preHandler: app.requireRole('admin') },
    async (req) => {
      const { notified, tournamentId } = parse(
        z.object({
          notified: z.enum(['true', 'false']).optional(),
          tournamentId: z.string().uuid().optional(),
        }),
        req.query,
      );
      // Default view is the pending queue (not yet notified).
      const notifiedFilter = notified === undefined ? false : notified === 'true';

      return db
        .select({
          id: registrationRemovals.id,
          tournamentId: registrationRemovals.tournamentId,
          tournamentTitle: tournaments.title,
          userId: registrationRemovals.userId,
          name: users.name,
          email: users.email,
          reason: registrationRemovals.reason,
          age: registrationRemovals.age,
          minAge: registrationRemovals.minAge,
          maxAge: registrationRemovals.maxAge,
          notified: registrationRemovals.notified,
          removedAt: registrationRemovals.removedAt,
          notifiedAt: registrationRemovals.notifiedAt,
        })
        .from(registrationRemovals)
        .innerJoin(users, eq(users.id, registrationRemovals.userId))
        .innerJoin(tournaments, eq(tournaments.id, registrationRemovals.tournamentId))
        .where(
          and(
            eq(registrationRemovals.notified, notifiedFilter),
            tournamentId
              ? eq(registrationRemovals.tournamentId, tournamentId)
              : undefined,
          ),
        )
        .orderBy(desc(registrationRemovals.removedAt));
    },
  );

  // Admin: mark removal records as notified once you've reached the players.
  app.post(
    '/admin/removed-registrations/mark-notified',
    { preHandler: app.requireRole('admin') },
    async (req) => {
      const { ids } = parse(
        z.object({ ids: z.array(z.string().uuid()).min(1) }),
        req.body,
      );
      const updated = await db
        .update(registrationRemovals)
        .set({ notified: true, notifiedAt: new Date() })
        .where(inArray(registrationRemovals.id, ids))
        .returning({ id: registrationRemovals.id });
      return { notified: updated.length };
    },
  );
}
