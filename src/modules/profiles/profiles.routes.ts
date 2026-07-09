import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { parse } from '../../lib/validate';
import { AppError } from '../../lib/errors';
import { db } from '../../db/client';
import { sportProfiles, sports } from '../../db/schema';
import { registry, getProfile, score, Profile, Question } from './rating';

const slugParam = z.object({ slug: z.string().min(1) });

// Onboarding answers are a flat map of questionId -> chosen option value.
const answersRecord = z.record(z.string(), z.string());

// The rendering-friendly view of a question: scoring internals (points/factor,
// role, rust flags) stay on the server; the frontend only needs prompt+options.
function renderQuestions(profile: Profile) {
  return profile.onboarding.questions.map((q: Question) => ({
    id: q.id,
    prompt: q.prompt ?? q.id,
    options: q.options.map((o) => ({ value: o.value, label: o.label ?? o.value })),
  }));
}

export async function profilesRoutes(app: FastifyInstance) {
  // Public: every sport that has a profile definition, with its questions as a
  // list. Lets the frontend show a sport picker + its form in one call.
  app.get('/questions', async () => {
    return Object.values(registry()).map((p) => ({
      sport: p.sport,
      displayName: p.displayName,
      archetype: p.archetype,
      questions: renderQuestions(p),
    }));
  });

  // Public: the questionnaire for a single sport, so the frontend can render the
  // form. Served from the sport's *.profile.json definition.
  app.get('/sports/:slug/questions', async (req) => {
    const { slug } = parse(slugParam, req.params);

    const profile = getProfile(slug);
    if (!profile) {
      throw new AppError('this sport has no profile questionnaire yet', 404);
    }
    return { sport: slug, displayName: profile.displayName, questions: renderQuestions(profile) };
  });

  // Authenticated: create or update the caller's profile for a sport.
  // Re-submitting overwrites the previous answers and re-seeds the rating.
  app.post('/sports/:slug/profile', { preHandler: app.authenticate }, async (req, reply) => {
    const { slug } = parse(slugParam, req.params);

    const definition = getProfile(slug);
    if (!definition) {
      throw new AppError('this sport has no profile questionnaire yet', 404);
    }

    const sport = (
      await db.select().from(sports).where(eq(sports.slug, slug)).limit(1)
    )[0];
    if (!sport) {
      throw new AppError('sport not found', 404);
    }

    // Validate the answers against the sport's definition and seed the rating
    // through the JSON-driven rating engine.
    const answers = parse(answersRecord, (req.body as any)?.answers);
    let placement: ReturnType<typeof score>;
    try {
      placement = score(definition, answers);
    } catch (err) {
      throw new AppError((err as Error).message, 400);
    }
    const rating = Math.round(placement.elo);

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

    return reply.code(201).send({ ...profile, placement });
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

  // Authenticated: the caller's profile for a single sport, or 404 if absent.
  app.get('/profiles/:slug', { preHandler: app.authenticate }, async (req) => {
    const { slug } = parse(slugParam, req.params);

    // TEMP debug: log the exact lookup parameters and which DB we're hitting.
    const dbHost = (() => {
      try {
        return new URL(process.env.DATABASE_URL ?? '').host;
      } catch {
        return 'unknown';
      }
    })();
    req.log.info(
      { userSub: req.user.sub, slug, dbHost },
      'GET /profiles/:slug — lookup params',
    );

    let rows;
    try {
      rows = await db
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
        .where(and(eq(sportProfiles.userId, req.user.sub), eq(sports.slug, slug)))
        .limit(1);
    } catch (err) {
      // Log the raw database error before it gets swallowed as a 500.
      req.log.error(
        { err, userSub: req.user.sub, slug, dbHost },
        'GET /profiles/:slug — database query failed',
      );
      throw err;
    }

    req.log.info(
      { userSub: req.user.sub, slug, matched: rows.length, row: rows[0] ?? null },
      'GET /profiles/:slug — query result',
    );

    const profile = rows[0];
    if (!profile) {
      throw new AppError('you have no profile for this sport yet', 404);
    }

    return profile;
  });
}
