import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../config/env';

export type SessionRole = 'player' | 'admin';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; email: string; role: SessionRole };
    user: { sub: string; email: string; role: SessionRole };
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireRole: (
      role: SessionRole,
    ) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export default fp(async (app) => {
  app.register(jwt, { secret: env.JWT_SECRET });

  app.decorate('authenticate', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await req.jwtVerify();
    } catch {
      await reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.decorate('requireRole', (role: SessionRole) => {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        await req.jwtVerify();
      } catch {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      if (req.user.role !== role) {
        return reply.code(403).send({ error: 'forbidden' });
      }
    };
  });
});
