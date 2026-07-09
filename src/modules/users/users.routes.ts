import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { desc, eq } from 'drizzle-orm';
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

export async function usersRoutes(app: FastifyInstance) {
  // Admin: the full record for one user — their account fields, every sport
  // profile (rating per sport), and their tournament registration history.
  // Use the userId from GET /tournaments/:id/registrations to look someone up.
  app.get('/admin/users/:id', { preHandler: app.requireRole('admin') }, async (req) => {
    const { id } = parse(idParam, req.params);

    const user = (
      await db
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          role: users.role,
          createdAt: users.createdAt,
        })
        .from(users)
        .where(eq(users.id, id))
        .limit(1)
    )[0];
    if (!user) {
      throw new AppError('user not found', 404);
    }

    const profiles = await db
      .select({
        id: sportProfiles.id,
        sportId: sportProfiles.sportId,
        sportSlug: sports.slug,
        sportName: sports.name,
        rating: sportProfiles.rating,
        attributes: sportProfiles.attributes,
        updatedAt: sportProfiles.updatedAt,
      })
      .from(sportProfiles)
      .innerJoin(sports, eq(sports.id, sportProfiles.sportId))
      .where(eq(sportProfiles.userId, id));

    const registrations = await db
      .select({
        registrationId: tournamentRegistrations.id,
        tournamentId: tournaments.id,
        title: tournaments.title,
        sportId: tournaments.sportId,
        startsAt: tournaments.startsAt,
        tournamentStatus: tournaments.status,
        status: tournamentRegistrations.status,
        registeredAt: tournamentRegistrations.createdAt,
      })
      .from(tournamentRegistrations)
      .innerJoin(tournaments, eq(tournaments.id, tournamentRegistrations.tournamentId))
      .where(eq(tournamentRegistrations.userId, id))
      .orderBy(desc(tournamentRegistrations.createdAt));

    return { user, profiles, registrations };
  });
}
