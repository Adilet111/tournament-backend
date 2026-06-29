import { FastifyInstance } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { db } from '../../db/client';
import { competitions } from '../../db/schema';

/**
 * Deprecated: tournaments are the single source of truth now (see
 * tournaments.routes.ts). Creating competitions has been removed; this list
 * route remains only for backwards compatibility and can be dropped along with
 * the competitions table.
 */
export async function competitionsRoutes(app: FastifyInstance) {
  // Public: list open competitions.
  app.get('/competitions', async () => {
    return db
      .select()
      .from(competitions)
      .where(eq(competitions.status, 'open'))
      .orderBy(desc(competitions.createdAt));
  });
}
