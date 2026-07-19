import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { ZodError } from 'zod';
import { corsOrigins, env } from './config/env';
import { AppError, codeForStatus } from './lib/errors';
import authPlugin from './plugins/auth';
import { authRoutes } from './modules/auth/auth.routes';
import { competitionsRoutes } from './modules/competitions/competitions.routes';
import { tournamentsRoutes } from './modules/tournaments/tournaments.routes';
import { sportsRoutes } from './modules/sports/sports.routes';
import { profilesRoutes } from './modules/profiles/profiles.routes';
import { usersRoutes } from './modules/users/users.routes';
import { citiesRoutes } from './modules/cities/cities.routes';
import { teamsRoutes } from './modules/teams/teams.routes';
import { matchesRoutes } from './modules/matches/matches.routes';
import { statsRoutes } from './modules/stats/stats.routes';

export function buildApp(): FastifyInstance {
  function loggerConfig() {
    if (env.NODE_ENV !== 'development') return true;
    try {
      // Use pino-pretty as an in-process stream (not a worker-thread transport).
      // A `transport` runs in a thread-stream worker, which deadlocks under the
      // IDE debugger and throws "_flushSync took too long (10s)" on pause/exit.
      const pretty = require('pino-pretty');
      return { stream: pretty({ colorize: true }) };
    } catch {
      return true; // pino-pretty not installed (e.g. prod image) -> plain logs
    }
  }


  const app = Fastify({
    logger: loggerConfig(),
  });

  // Restrict browsers to the configured origins in production; with no
  // CORS_ORIGINS set (development) any origin is reflected.
  app.register(cors, {
    origin: corsOrigins.length > 0 ? corsOrigins : true,
    credentials: true,
  });
  app.register(authPlugin);

  // Every error response carries a stable machine-readable `code` alongside
  // the human-readable `error` message, so the frontend can map codes to
  // user-friendly / translated messages without string-matching.
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: err.message, code: err.code });
    }
    if (err instanceof ZodError) {
      return reply
        .code(400)
        .send({ error: 'invalid request', code: 'validation_error', issues: err.issues });
    }
    req.log.error(err);
    const statusCode =
      typeof err === 'object' && err !== null && 'statusCode' in err
        ? ((err as { statusCode?: number }).statusCode ?? 500)
        : 500;
    return reply
      .code(statusCode)
      .send({ error: 'internal server error', code: codeForStatus(statusCode) });
  });

  // Defense-in-depth headers for API responses. The SPA's own CSP is set by
  // nginx where the HTML is served; these only cover direct API access.
  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    reply.header('Referrer-Policy', 'no-referrer');
  });

  // All routes live under /api so nginx can proxy a single prefix and the
  // frontend (served at /) owns everything else. e.g. GET /api/tournaments.
  app.register(
    async (api) => {
      api.get('/health', async () => ({ status: 'ok' }));

      // Register module routes here.
      api.register(authRoutes);
      api.register(competitionsRoutes);
      api.register(tournamentsRoutes);
      api.register(sportsRoutes);
      api.register(profilesRoutes);
      api.register(usersRoutes);
      api.register(citiesRoutes);
      api.register(teamsRoutes);
      api.register(matchesRoutes);
      api.register(statsRoutes);
    },
    { prefix: '/api' },
  );

  return app;
}
