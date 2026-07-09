import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { ZodError } from 'zod';
import { env } from './config/env';
import { AppError } from './lib/errors';
import authPlugin from './plugins/auth';
import { authRoutes } from './modules/auth/auth.routes';
import { competitionsRoutes } from './modules/competitions/competitions.routes';
import { tournamentsRoutes } from './modules/tournaments/tournaments.routes';
import { sportsRoutes } from './modules/sports/sports.routes';
import { profilesRoutes } from './modules/profiles/profiles.routes';
import { usersRoutes } from './modules/users/users.routes';

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
    logger:loggerConfig(),
  });

  app.register(cors, { origin: true, credentials: true });
  app.register(authPlugin);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: err.message });
    }
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'invalid request', issues: err.issues });
    }
    req.log.error(err);
    return reply.code(err.statusCode ?? 500).send({ error: 'internal server error' });
  });

  // All routes live under /api so nginx can proxy a single prefix and the
  // frontend (served at /) owns everything else. e.g. GET /api/tournaments.
  app.register(
    async (api) => {
      api.get('/health', async () => ({ status: 'ok3' }));

      // Register module routes here.
      api.register(authRoutes);
      api.register(competitionsRoutes);
      api.register(tournamentsRoutes);
      api.register(sportsRoutes);
      api.register(profilesRoutes);
      api.register(usersRoutes);
    },
    { prefix: '/api' },
  );

  return app;
}
