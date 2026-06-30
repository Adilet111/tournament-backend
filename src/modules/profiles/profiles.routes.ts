import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { parse } from '../../lib/validate';
import { AppError } from '../../lib/errors';
import { db } from '../../db/client';
import { sportProfiles, sports } from '../../db/schema';
import { getSportConfig } from './sportConfigs';

const slugParam = z.object({ slug: z.string().min(1) });

export async function profilesRoutes(app: FastifyInstance) {
  // Public: the questionnaire for a sport, so the frontend can render the form.
  app.get('/sports/:slug/questions', async (req) => {
    const { slug } = parse(slugParam, req.params);
    const config = getSportConfig(slug);
    if (!config) {
      throw new AppError('this sport has no profile questionnaire yet', 404);
    }
    return { sport: slug, questions: config.questions };
  });

  // Authenticated: create or update the caller's profile for a sport.
  // Re-submitting overwrites the previous answers and re-seeds the rating.
  app.post('/sports/:slug/profile', { preHandler: app.authenticate }, async (req, reply) => {
    const { slug } = parse(slugParam, req.params);

    const config = getSportConfig(slug);
    if (!config) {
      throw new AppError('this sport has no profile questionnaire yet', 404);
    }

    const sport = (
      await db.select().from(sports).where(eq(sports.slug, slug)).limit(1)
    )[0];
    if (!sport) {
      throw new AppError('sport not found', 404);
    }

    // Validate the answers against this sport's schema, then seed the rating.
    const answers = parse(config.answers, (req.body as any)?.answers);
    const rating = config.seedRating(answers);

    const profile = (
      await db
        .insert(sportProfiles)
        .values({ userId: req.user.sub, sportId: sport.id, attributes: answers, rating })
        .onConflictDoUpdate({
          target: [sportProfiles.userId, sportProfiles.sportId],
          set: { attributes: answers, rating, updatedAt: new Date() },
        })
        .returning()
    )[0];

    return reply.code(201).send(profile);
  });

  // Authenticated: list the caller's sport profiles.
  app.get('/me/profiles', { preHandler: app.authenticate }, async (req) => {
    return db
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
      .where(eq(sportProfiles.userId, req.user.sub));
  });
}
