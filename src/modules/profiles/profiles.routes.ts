import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { parse } from '../../lib/validate';
import { AppError } from '../../lib/errors';
import { db } from '../../db/client';
import { sportProfiles, sports, users } from '../../db/schema';
import { registry, getProfile, score, place, clamp, Profile, Question } from './rating';

const slugParam = z.object({ slug: z.string().min(1) });
const userSportParams = z.object({ userId: z.string().uuid(), slug: z.string().min(1) });
const adjustRatingBody = z.object({ delta: z.number().int() });

// Onboarding answers are a flat map of questionId -> chosen option value.
const answersRecord = z.record(z.string(), z.string());

type Lang = 'en' | 'ru';

// Questionnaire text (prompts/labels/displayName) is localized; the computed
// results (rating, tier/division names like "Bronze III") are not — those
// come from the *.profile.json `tiers`/`divisionLabels` and stay in English.
// Default is Russian: with no Accept-Language header (or one that doesn't
// mention "ru"), Russian is shown unless the header names another language.
function pickLang(acceptLanguage: string | undefined): Lang {
  if (!acceptLanguage || acceptLanguage.trim() === '') return 'ru';
  return acceptLanguage.toLowerCase().includes('ru') ? 'ru' : 'en';
}

function localizedDisplayName(profile: Profile, lang: Lang) {
  return (lang === 'ru' ? profile.displayNameRu : undefined) ?? profile.displayName;
}

// The rendering-friendly view of a question: scoring internals (points/factor,
// role, rust flags) stay on the server; the frontend only needs prompt+options.
function renderQuestions(profile: Profile, lang: Lang) {
  return profile.onboarding.questions.map((q: Question) => ({
    id: q.id,
    prompt: (lang === 'ru' ? q.promptRu : undefined) ?? q.prompt ?? q.id,
    options: q.options.map((o) => ({
      value: o.value,
      label: (lang === 'ru' ? o.labelRu : undefined) ?? o.label ?? o.value,
    })),
  }));
}

export async function profilesRoutes(app: FastifyInstance) {
  // Public: every sport that has a profile definition, with its questions as a
  // list. Lets the frontend show a sport picker + its form in one call.
  // Localized via Accept-Language (defaults to Russian; "ru" -> Russian,
  // anything else -> English).
  app.get('/questions', async (req) => {
    const lang = pickLang(req.headers['accept-language']);
    return Object.values(registry()).map((p) => ({
      sport: p.sport,
      displayName: localizedDisplayName(p, lang),
      archetype: p.archetype,
      questions: renderQuestions(p, lang),
    }));
  });

  // Public: the questionnaire for a single sport, so the frontend can render the
  // form. Served from the sport's *.profile.json definition. Localized via
  // Accept-Language (see /questions above).
  app.get('/sports/:slug/questions', async (req) => {
    const { slug } = parse(slugParam, req.params);
    const lang = pickLang(req.headers['accept-language']);

    const profile = getProfile(slug);
    if (!profile) {
      throw new AppError('this sport has no profile questionnaire yet', 404);
    }
    return {
      sport: slug,
      displayName: localizedDisplayName(profile, lang),
      questions: renderQuestions(profile, lang),
    };
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
  // Available at both /profiles/:slug and /sports/:slug/profile (symmetric with
  // the POST above).
  const getProfileHandler = async (req: any) => {
    const { slug } = parse(slugParam, req.params);

    const profile = (
      await db
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
        .limit(1)
    )[0];

    if (!profile) {
      throw new AppError('you have no profile for this sport yet', 404);
    }

    return profile;
  };

  app.get('/profiles/:slug', { preHandler: app.authenticate }, getProfileHandler);
  app.get('/sports/:slug/profile', { preHandler: app.authenticate }, getProfileHandler);

  // Public: the tier/division config for a sport, so the frontend can compute
  // "tier + division + LP" from a raw rating locally (e.g. to render a live
  // preview while a user drags a slider) without hardcoding numbers that could
  // drift from the *.profile.json. Tier/division names are never localized.
  app.get('/sports/:slug/tiers', async (req) => {
    const { slug } = parse(slugParam, req.params);
    const profile = getProfile(slug);
    if (!profile) {
      throw new AppError('this sport has no profile questionnaire yet', 404);
    }
    return {
      sport: slug,
      constants: profile.onboarding.constants,
      tiers: profile.tiers,
      divisionLabels: profile.divisionLabels,
      lpScale: profile.lpScale,
    };
  });

  // Admin: manually adjust a user's rating for one sport by a signed delta
  // (e.g. +25 or -25), for corrections or penalties outside normal match play.
  // Clamped to the sport's FLOOR/CAP, same bounds as onboarding and match play.
  app.post(
    '/admin/users/:userId/sports/:slug/rating/adjust',
    { preHandler: app.requireRole('admin') },
    async (req) => {
      const { userId, slug } = parse(userSportParams, req.params);
      const { delta } = parse(adjustRatingBody, req.body);

      const definition = getProfile(slug);
      if (!definition) {
        throw new AppError('this sport has no profile questionnaire yet', 404);
      }

      const user = (
        await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1)
      )[0];
      if (!user) {
        throw new AppError('user not found', 404);
      }

      const sport = (
        await db.select().from(sports).where(eq(sports.slug, slug)).limit(1)
      )[0];
      if (!sport) {
        throw new AppError('sport not found', 404);
      }

      const existing = (
        await db
          .select()
          .from(sportProfiles)
          .where(and(eq(sportProfiles.userId, userId), eq(sportProfiles.sportId, sport.id)))
          .limit(1)
      )[0];
      if (!existing) {
        throw new AppError('this user has no profile in this sport', 404);
      }

      const { FLOOR, CAP } = definition.onboarding.constants;
      const oldRating = existing.rating ?? FLOOR;
      const newRating = clamp(oldRating + delta, FLOOR, CAP);

      const updated = (
        await db
          .update(sportProfiles)
          .set({ rating: newRating, updatedAt: new Date() })
          .where(eq(sportProfiles.id, existing.id))
          .returning()
      )[0];

      req.log.info(
        { userId, sportSlug: slug, delta, oldRating, newRating, byAdmin: req.user.sub },
        'admin adjusted rating',
      );

      return { ...updated, placement: place(definition, newRating) };
    },
  );
}
