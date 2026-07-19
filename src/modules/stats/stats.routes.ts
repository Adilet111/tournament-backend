import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { parse } from '../../lib/validate';
import { AppError } from '../../lib/errors';
import { db } from '../../db/client';
import {
  matchParticipants,
  matches,
  sportProfiles,
  sports,
  teams,
  tournamentEntries,
  tournamentRegistrations,
  tournamentTeamRegistrationMembers,
  tournamentTeamRegistrations,
  tournaments,
  users,
} from '../../db/schema';

const idParam = z.object({ id: z.string().uuid() });

/**
 * Score awarded on top of the raw counters, so activity and results both pay:
 * entering a bracket, winning matches, and finishing high all add points.
 * Purely derived — recomputed on every request from the match/entry tables.
 */
const POINTS = {
  participation: 10,
  matchWin: 5,
  champion: 50,
  runnerUp: 30,
  semifinal: 20,
};

function placementPoints(finalRank: number | null): number {
  if (finalRank === 1) return POINTS.champion;
  if (finalRank === 2) return POINTS.runnerUp;
  if (finalRank === 3) return POINTS.semifinal;
  return 0;
}

/**
 * Everything derivable about one user's tournament history, from the entry and
 * match tables (solo entries via their registration, team entries via the
 * frozen roster snapshots). Walkovers (byes) don't count as played matches.
 */
async function buildUserStats(userId: string) {
  const soloEntries = await db
    .select({
      entry: tournamentEntries,
      tournament: tournaments,
      sportId: sports.id,
      sportName: sports.name,
      sportSlug: sports.slug,
    })
    .from(tournamentEntries)
    .innerJoin(
      tournamentRegistrations,
      eq(tournamentRegistrations.id, tournamentEntries.registrationId),
    )
    .innerJoin(tournaments, eq(tournaments.id, tournamentEntries.tournamentId))
    .innerJoin(sports, eq(sports.id, tournaments.sportId))
    .where(eq(tournamentRegistrations.userId, userId));

  const teamEntries = await db
    .select({
      entry: tournamentEntries,
      tournament: tournaments,
      sportId: sports.id,
      sportName: sports.name,
      sportSlug: sports.slug,
      teamName: teams.name,
    })
    .from(tournamentEntries)
    .innerJoin(
      tournamentTeamRegistrations,
      eq(tournamentTeamRegistrations.id, tournamentEntries.teamRegistrationId),
    )
    .innerJoin(
      tournamentTeamRegistrationMembers,
      eq(
        tournamentTeamRegistrationMembers.registrationId,
        tournamentTeamRegistrations.id,
      ),
    )
    .innerJoin(teams, eq(teams.id, tournamentTeamRegistrations.teamId))
    .innerJoin(tournaments, eq(tournaments.id, tournamentEntries.tournamentId))
    .innerJoin(sports, eq(sports.id, tournaments.sportId))
    .where(eq(tournamentTeamRegistrationMembers.userId, userId));

  const allEntries = [
    ...soloEntries.map((r) => ({ ...r, teamName: null as string | null })),
    ...teamEntries,
  ];

  // Wins/losses per entry, only over actually played (completed) matches.
  const winLoss = new Map<string, { played: number; won: number }>();
  if (allEntries.length > 0) {
    const rows = await db
      .select({
        entryId: matchParticipants.entryId,
        outcome: matchParticipants.outcome,
      })
      .from(matchParticipants)
      .innerJoin(matches, eq(matches.id, matchParticipants.matchId))
      .where(
        and(
          inArray(
            matchParticipants.entryId,
            allEntries.map((e) => e.entry.id),
          ),
          eq(matches.status, 'completed'),
        ),
      );
    for (const row of rows) {
      const agg = winLoss.get(row.entryId) ?? { played: 0, won: 0 };
      agg.played += 1;
      if (row.outcome === 'win') agg.won += 1;
      winLoss.set(row.entryId, agg);
    }
  }

  type Bucket = {
    tournamentsPlayed: number;
    tournamentsWon: number;
    podiumFinishes: number;
    matchesPlayed: number;
    matchesWon: number;
    matchesLost: number;
    winRate: number | null;
    score: number;
  };
  const emptyBucket = (): Bucket => ({
    tournamentsPlayed: 0,
    tournamentsWon: 0,
    podiumFinishes: 0,
    matchesPlayed: 0,
    matchesWon: 0,
    matchesLost: 0,
    winRate: null,
    score: 0,
  });

  const overall = emptyBucket();
  const bySport = new Map<
    string,
    Bucket & { sportId: string; sportName: string; sportSlug: string }
  >();
  const perTournament: unknown[] = [];

  for (const { entry, tournament, sportId, sportName, sportSlug, teamName } of allEntries) {
    const wl = winLoss.get(entry.id) ?? { played: 0, won: 0 };
    const buckets: Bucket[] = [overall];
    let sport = bySport.get(sportId);
    if (!sport) {
      sport = { ...emptyBucket(), sportId, sportName, sportSlug };
      bySport.set(sportId, sport);
    }
    buckets.push(sport);

    for (const b of buckets) {
      b.tournamentsPlayed += 1;
      if (entry.finalRank === 1) b.tournamentsWon += 1;
      if (entry.finalRank !== null && entry.finalRank <= 3) b.podiumFinishes += 1;
      b.matchesPlayed += wl.played;
      b.matchesWon += wl.won;
      b.matchesLost += wl.played - wl.won;
      b.score +=
        POINTS.participation + wl.won * POINTS.matchWin + placementPoints(entry.finalRank);
    }

    perTournament.push({
      tournamentId: tournament.id,
      title: tournament.title,
      status: tournament.status,
      startsAt: tournament.startsAt,
      participantType: tournament.participantType,
      sportSlug,
      teamName,
      seed: entry.seed,
      finalRank: entry.finalRank,
      matchesPlayed: wl.played,
      matchesWon: wl.won,
    });
  }

  const rate = (b: Bucket) => {
    b.winRate = b.matchesPlayed > 0 ? Math.round((b.matchesWon / b.matchesPlayed) * 100) / 100 : null;
  };
  rate(overall);
  for (const b of bySport.values()) rate(b);

  // Attach the current per-sport profile rating for context.
  const profiles = await db
    .select({ sportId: sportProfiles.sportId, rating: sportProfiles.rating })
    .from(sportProfiles)
    .where(eq(sportProfiles.userId, userId));
  const ratingBySport = new Map(profiles.map((p) => [p.sportId, p.rating]));

  return {
    userId,
    overall,
    bySport: [...bySport.values()].map((b) => ({
      ...b,
      rating: ratingBySport.get(b.sportId) ?? null,
    })),
    tournaments: perTournament,
  };
}

export async function statsRoutes(app: FastifyInstance) {
  // Authenticated: your own tournament statistics — how many tournaments you
  // entered, matches won per tournament, and the derived score.
  app.get('/me/stats', { preHandler: app.authenticate }, async (req) => {
    const stats = await buildUserStats(req.user.sub);
    req.log.info(
      { userId: req.user.sub, tournamentsPlayed: stats.overall.tournamentsPlayed },
      'user stats computed',
    );
    return stats;
  });

  // Admin: any user's statistics.
  app.get('/users/:id/stats', { preHandler: app.requireRole('admin') }, async (req) => {
    const { id } = parse(idParam, req.params);
    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, id)).limit(1);
    if (!user) throw new AppError('user not found', 404);
    return buildUserStats(id);
  });
}
