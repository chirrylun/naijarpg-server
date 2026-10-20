import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env';
import { requireUser } from '../../middleware/auth';
import { getAdminStats, getLandingStats, recordVisit } from './stats.service';

const admins = new Set(env.ADMIN_USER_IDS.split(',').map((s) => s.trim()).filter(Boolean));

export async function statsRoutes(app: FastifyInstance) {
  app.get('/landing', async () => getLandingStats());

  // Stricter limit: one browser shouldn't be able to inflate the counter
  app.post(
    '/visit',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async () => ({ totalVisits: await recordVisit() }),
  );

  // Owner-only numbers for the /stats page
  app.get(
    '/admin',
    { onRequest: requireUser, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      // a signed-in person who is not on the list gets their own id back, so they can add it to ADMIN_USER_IDS
      if (!admins.has(req.userId)) return reply.code(403).send({ error: 'forbidden', userId: req.userId });
      const { days } = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }).parse(req.query);
      return getAdminStats(days);
    },
  );
}
