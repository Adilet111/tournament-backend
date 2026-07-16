import { FastifyInstance } from 'fastify';
import { CITIES } from '../../lib/cities';

export async function citiesRoutes(app: FastifyInstance) {
  // Public: the canonical city list for dropdowns. Each item is
  // { slug, en, ru } — the frontend picks the label by the user's locale and
  // sends the slug back when creating a tournament.
  app.get('/cities', async () => CITIES);
}
