import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { parse } from '../../lib/validate';
import { AppError } from '../../lib/errors';
import { db } from '../../db/client';
import {
  matchParticipants,
  matches,
  sportProfiles,
  teams,
  tournamentEntries,
  tournamentRegistrations,
  tournamentTeamRegistrationMembers,
  tournamentTeamRegistrations,
  tournaments,
  users,
} from '../../db/schema';

const idParam = z.object({ id: z.string().uuid() });

const resultBody = z.object({
  winnerSlot: z.union([z.literal(1), z.literal(2)]),
  score1: z.number().int().nonnegative().optional(),
  score2: z.number().int().nonnegative().optional(),
});

async function loadTournamentOr404(id: string) {
  const [t] = await db.select().from(tournaments).where(eq(tournaments.id, id)).limit(1);
  if (!t) throw new AppError('tournament not found', 404);
  return t;
}

/**
 * Standard single-elimination seed placement. Returns, for a bracket of
 * `size` (a power of two), the seed number occupying each first-round line —
 * e.g. size 8 -> [1, 8, 4, 5, 2, 7, 3, 6], so match 0 is seed 1 vs seed 8
 * and the top two seeds can only meet in the final.
 */
function seedLines(size: number): number[] {
  let lines = [1];
  while (lines.length < size) {
    const doubled = lines.length * 2;
    const next: number[] = [];
    for (const s of lines) next.push(s, doubled + 1 - s);
    lines = next;
  }
  return lines;
}

/**
 * The competitors to seed, unified across solo and team tournaments:
 * solo -> one candidate per registered player (rating from their profile),
 * team -> one per registered team (rating = average of the snapshot roster).
 */
async function collectCandidates(t: typeof tournaments.$inferSelect) {
  if (t.participantType === 'solo') {
    const rows = await db
      .select({
        registrationId: tournamentRegistrations.id,
        name: users.name,
        email: users.email,
        rating: sportProfiles.rating,
      })
      .from(tournamentRegistrations)
      .innerJoin(users, eq(users.id, tournamentRegistrations.userId))
      .leftJoin(
        sportProfiles,
        and(
          eq(sportProfiles.userId, tournamentRegistrations.userId),
          eq(sportProfiles.sportId, t.sportId),
        ),
      )
      .where(
        and(
          eq(tournamentRegistrations.tournamentId, t.id),
          eq(tournamentRegistrations.status, 'registered'),
        ),
      );
    return rows.map((r) => ({
      registrationId: r.registrationId as string | null,
      teamRegistrationId: null as string | null,
      displayName: r.name ?? r.email,
      rating: r.rating,
    }));
  }

  const regs = await db
    .select({
      teamRegistrationId: tournamentTeamRegistrations.id,
      teamName: teams.name,
    })
    .from(tournamentTeamRegistrations)
    .innerJoin(teams, eq(teams.id, tournamentTeamRegistrations.teamId))
    .where(
      and(
        eq(tournamentTeamRegistrations.tournamentId, t.id),
        eq(tournamentTeamRegistrations.status, 'registered'),
      ),
    );
  if (regs.length === 0) return [];

  // Team strength for seeding = average member rating from the frozen roster.
  const rosterRatings = await db
    .select({
      registrationId: tournamentTeamRegistrationMembers.registrationId,
      rating: sportProfiles.rating,
    })
    .from(tournamentTeamRegistrationMembers)
    .leftJoin(
      sportProfiles,
      and(
        eq(sportProfiles.userId, tournamentTeamRegistrationMembers.userId),
        eq(sportProfiles.sportId, t.sportId),
      ),
    )
    .where(
      inArray(
        tournamentTeamRegistrationMembers.registrationId,
        regs.map((r) => r.teamRegistrationId),
      ),
    );
  const byReg = new Map<string, number[]>();
  for (const row of rosterRatings) {
    if (row.rating === null) continue;
    const list = byReg.get(row.registrationId) ?? [];
    list.push(row.rating);
    byReg.set(row.registrationId, list);
  }

  return regs.map((r) => {
    const ratings = byReg.get(r.teamRegistrationId) ?? [];
    const rating =
      ratings.length > 0
        ? Math.round(ratings.reduce((a, b) => a + b, 0) / ratings.length)
        : null;
    return {
      registrationId: null as string | null,
      teamRegistrationId: r.teamRegistrationId as string | null,
      displayName: r.teamName,
      rating,
    };
  });
}

// Rank an eliminated entry earns by losing in `round` of an `totalRounds`
// bracket: final loser is 2nd, semifinal losers share 3rd, quarterfinal
// losers share 5th, and so on.
function loserRank(round: number, totalRounds: number): number {
  return round === totalRounds ? 2 : Math.pow(2, totalRounds - round) + 1;
}

export async function matchesRoutes(app: FastifyInstance) {
  // Admin: generate the whole single-elimination bracket for a closed
  // tournament. Entries are frozen from the registered players/teams, seeded
  // by rating (unrated last); byes resolve immediately as walkovers.
  app.post(
    '/tournaments/:id/bracket',
    { preHandler: app.requireRole('admin') },
    async (req, reply) => {
      const { id } = parse(idParam, req.params);
      const tournament = await loadTournamentOr404(id);
      if (tournament.status !== 'closed') {
        throw new AppError(
          'close registration before generating the bracket',
          409,
          'tournament_not_closed',
        );
      }

      const [existing] = await db
        .select({ id: matches.id })
        .from(matches)
        .where(eq(matches.tournamentId, id))
        .limit(1);
      if (existing) {
        throw new AppError('bracket already generated', 409, 'bracket_exists');
      }

      const candidates = await collectCandidates(tournament);
      if (candidates.length < 2) {
        throw new AppError('at least 2 registered participants are needed', 409);
      }

      // Seed 1 = highest rating; unrated entries go last in registration order.
      candidates.sort((a, b) => {
        if (a.rating === null && b.rating === null) return 0;
        if (a.rating === null) return 1;
        if (b.rating === null) return -1;
        return b.rating - a.rating;
      });

      const size = 2 ** Math.ceil(Math.log2(candidates.length));
      const rounds = Math.log2(size);

      const result = await db.transaction(async (tx) => {
        const entries = await tx
          .insert(tournamentEntries)
          .values(
            candidates.map((c, i) => ({
              tournamentId: id,
              registrationId: c.registrationId,
              teamRegistrationId: c.teamRegistrationId,
              displayName: c.displayName,
              seed: i + 1,
            })),
          )
          .returning();
        const entryBySeed = new Map(entries.map((e) => [e.seed!, e]));

        // Create rounds from the final backwards so next_match_id is known.
        // matchesByRound[r][p] = match at round r+1, position p.
        const matchesByRound: (typeof matches.$inferSelect)[][] = [];
        for (let round = rounds; round >= 1; round--) {
          const matchCount = size / 2 ** round;
          const nextRound = matchesByRound[0]; // previous iteration (round + 1)
          const created = await tx
            .insert(matches)
            .values(
              Array.from({ length: matchCount }, (_, position) => ({
                tournamentId: id,
                round,
                position,
                nextMatchId: nextRound ? nextRound[Math.floor(position / 2)].id : null,
                nextMatchSlot: nextRound ? (position % 2) + 1 : null,
              })),
            )
            .returning();
          created.sort((a, b) => a.position - b.position);
          matchesByRound.unshift(created);
        }
        const firstRound = matchesByRound[0];

        // Place seeds on the canonical lines; seeds beyond the field are byes.
        const lines = seedLines(size);
        const walkovers: string[] = [];
        for (const match of firstRound) {
          const seedA = lines[match.position * 2];
          const seedB = lines[match.position * 2 + 1];
          const a = entryBySeed.get(seedA);
          const b = entryBySeed.get(seedB);
          const present = [a, b].filter((e): e is NonNullable<typeof e> => Boolean(e));

          if (a) {
            await tx
              .insert(matchParticipants)
              .values({ matchId: match.id, entryId: a.id, slot: 1 });
          }
          if (b) {
            await tx
              .insert(matchParticipants)
              .values({ matchId: match.id, entryId: b.id, slot: 2 });
          }

          // Bye: the lone participant advances immediately.
          if (present.length === 1 && match.nextMatchId && match.nextMatchSlot) {
            await tx
              .update(matches)
              .set({ status: 'walkover' })
              .where(eq(matches.id, match.id));
            await tx.insert(matchParticipants).values({
              matchId: match.nextMatchId,
              entryId: present[0].id,
              slot: match.nextMatchSlot,
            });
            walkovers.push(match.id);
          }
        }

        return { entries: entries.length, matches: size - 1, walkovers: walkovers.length };
      });

      req.log.info(
        { tournamentId: id, byAdmin: req.user.sub, ...result, bracketSize: size, rounds },
        'bracket generated',
      );
      return reply.code(201).send({ tournamentId: id, bracketSize: size, rounds, ...result });
    },
  );

  // Admin: throw the bracket away (e.g. a late withdrawal before play starts)
  // so it can be regenerated. Blocked once any match has been played.
  app.delete(
    '/tournaments/:id/bracket',
    { preHandler: app.requireRole('admin') },
    async (req, reply) => {
      const { id } = parse(idParam, req.params);
      await loadTournamentOr404(id);

      const [played] = await db
        .select({ id: matches.id })
        .from(matches)
        .where(and(eq(matches.tournamentId, id), eq(matches.status, 'completed')))
        .limit(1);
      if (played) {
        throw new AppError(
          'matches have been played; the bracket can no longer be deleted',
          409,
          'bracket_in_progress',
        );
      }

      await db.transaction(async (tx) => {
        // next_match_id has no ON DELETE cascade; unlink before deleting.
        await tx
          .update(matches)
          .set({ nextMatchId: null, nextMatchSlot: null })
          .where(eq(matches.tournamentId, id));
        await tx.delete(matches).where(eq(matches.tournamentId, id));
        await tx.delete(tournamentEntries).where(eq(tournamentEntries.tournamentId, id));
      });
      req.log.info({ tournamentId: id, byAdmin: req.user.sub }, 'bracket deleted');
      return reply.code(204).send();
    },
  );

  // Public: the bracket — every match grouped by round, with sides and
  // scores, plus the seeded entry list.
  app.get('/tournaments/:id/bracket', async (req) => {
    const { id } = parse(idParam, req.params);
    await loadTournamentOr404(id);

    const entries = await db
      .select()
      .from(tournamentEntries)
      .where(eq(tournamentEntries.tournamentId, id))
      .orderBy(asc(tournamentEntries.seed));
    if (entries.length === 0) {
      return { generated: false, entries: [], rounds: [] };
    }
    const nameByEntry = new Map(entries.map((e) => [e.id, e.displayName]));

    const allMatches = await db
      .select()
      .from(matches)
      .where(eq(matches.tournamentId, id))
      .orderBy(asc(matches.round), asc(matches.position));
    const participants = await db
      .select()
      .from(matchParticipants)
      .where(
        inArray(
          matchParticipants.matchId,
          allMatches.map((m) => m.id),
        ),
      );
    const byMatch = new Map<string, typeof participants>();
    for (const p of participants) {
      const list = byMatch.get(p.matchId) ?? [];
      list.push(p);
      byMatch.set(p.matchId, list);
    }

    const roundsOut: { round: number; matches: unknown[] }[] = [];
    for (const m of allMatches) {
      let bucket = roundsOut.find((r) => r.round === m.round);
      if (!bucket) {
        bucket = { round: m.round, matches: [] };
        roundsOut.push(bucket);
      }
      const sides = (byMatch.get(m.id) ?? [])
        .sort((a, b) => a.slot - b.slot)
        .map((p) => ({
          slot: p.slot,
          entryId: p.entryId,
          displayName: nameByEntry.get(p.entryId) ?? null,
          score: p.score,
          outcome: p.outcome,
        }));
      bucket.matches.push({
        id: m.id,
        round: m.round,
        position: m.position,
        status: m.status,
        playedAt: m.playedAt,
        nextMatchId: m.nextMatchId,
        participants: sides,
      });
    }

    return { generated: true, entries, rounds: roundsOut };
  });

  // Admin: report a match result. Sets scores/outcomes, advances the winner
  // to the next round, and assigns final ranks as entries are eliminated.
  app.post(
    '/matches/:id/result',
    { preHandler: app.requireRole('admin') },
    async (req) => {
      const { id } = parse(idParam, req.params);
      const body = parse(resultBody, req.body);

      const [match] = await db.select().from(matches).where(eq(matches.id, id)).limit(1);
      if (!match) throw new AppError('match not found', 404);
      if (match.status === 'completed') {
        throw new AppError('this match already has a result', 409, 'match_completed');
      }
      if (match.status === 'walkover') {
        throw new AppError('this match was a walkover (bye)', 409, 'match_walkover');
      }

      const sides = await db
        .select()
        .from(matchParticipants)
        .where(eq(matchParticipants.matchId, id));
      if (sides.length !== 2) {
        throw new AppError(
          'both sides of this match are not decided yet',
          409,
          'match_not_ready',
        );
      }

      const winner = sides.find((s) => s.slot === body.winnerSlot)!;
      const loser = sides.find((s) => s.slot !== body.winnerSlot)!;

      const updated = await db.transaction(async (tx) => {
        const scoreBySlot: Record<number, number | undefined> = {
          1: body.score1,
          2: body.score2,
        };
        await tx
          .update(matchParticipants)
          .set({ outcome: 'win', score: scoreBySlot[winner.slot] ?? null })
          .where(eq(matchParticipants.id, winner.id));
        await tx
          .update(matchParticipants)
          .set({ outcome: 'loss', score: scoreBySlot[loser.slot] ?? null })
          .where(eq(matchParticipants.id, loser.id));
        const [done] = await tx
          .update(matches)
          .set({ status: 'completed', playedAt: new Date() })
          .where(eq(matches.id, id))
          .returning();

        // Count rounds to translate "lost in round r" into a final rank.
        const all = await tx
          .select({ round: matches.round })
          .from(matches)
          .where(eq(matches.tournamentId, match.tournamentId));
        const totalRounds = Math.max(...all.map((m) => m.round));

        await tx
          .update(tournamentEntries)
          .set({ finalRank: loserRank(match.round, totalRounds) })
          .where(eq(tournamentEntries.id, loser.entryId));

        if (match.nextMatchId && match.nextMatchSlot) {
          await tx.insert(matchParticipants).values({
            matchId: match.nextMatchId,
            entryId: winner.entryId,
            slot: match.nextMatchSlot,
          });
        } else {
          // That was the final: crown the champion.
          await tx
            .update(tournamentEntries)
            .set({ finalRank: 1 })
            .where(eq(tournamentEntries.id, winner.entryId));
        }
        return done;
      });

      req.log.info(
        {
          matchId: id,
          tournamentId: match.tournamentId,
          round: match.round,
          winnerEntryId: winner.entryId,
          loserEntryId: loser.entryId,
          byAdmin: req.user.sub,
          isFinal: match.nextMatchId === null,
        },
        'match result reported',
      );
      return updated;
    },
  );
}
