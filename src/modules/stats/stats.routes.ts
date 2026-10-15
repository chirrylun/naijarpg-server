import type { FastifyInstance } from 'fastify';
import { getLandingStats, recordVisit } from './stats.service';

export async function statsRoutes(app: FastifyInstance) {
  app.get('/landing', async () => getLandingStats());

  // Stricter limit: one browser shouldn't be able to inflate the counter
  app.post(
    '/visit',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async () => ({ totalVisits: await recordVisit() }),
  );
}