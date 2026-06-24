import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { ZodError } from 'zod';
import { env } from './config/env';
import { AppError } from './lib/errors';
import authPlugin from './plugins/auth';
import { authRoutes } from './modules/auth/auth.routes';
import { competitionsRoutes } from './modules/competitions/competitions.routes';

export function buildApp(): FastifyInstance {
  function loggerConfig() {
    if (env.NODE_ENV !== 'development') return true;
    try {
      require.resolve('pino-pretty');
      return { transport: { target: 'pino-pretty' } };
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

  app.get('/health', async () => ({ status: 'ok' }));

  // Register module routes here.
  app.register(authRoutes);
  app.register(competitionsRoutes);

  return app;
}
