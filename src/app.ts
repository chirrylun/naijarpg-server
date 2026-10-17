import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { env } from './config/env';
import { AppError } from './lib/errors';
import { statsRoutes } from './modules/stats/stats.routes'
import { userRoutes } from './modules/users/users.routes';
import { encounterRoutes } from './modules/encounters/encounters.routes';
import { leaderboardRoutes } from './modules/leaderboard/leaderboard.routes';
import { dailyRoutes } from './modules/daily/daily.routes';
import { starRoutes, bachsWebhook } from './modules/stars/stars.routes';
import { avatarRoutes } from './modules/avatars/avatars.routes';
import { referralRoutes } from './modules/referrals/referrals.routes';
import { chatRoutes } from './modules/chat/chat.routes';
import { ORIGINS } from './config/env';

export function buildApp() {
  // trustProxy: behind Railway/Render, use the real client IP for rate limiting
  const app = Fastify({ logger: true, trustProxy: true });

  app.decorateRequest('userId', '');
  app.decorateRequest('authEmail', null);
  app.decorateRequest('isAnonymous', true);

    app.register(cors, { origin: ORIGINS, methods: ['GET', 'POST', 'PATCH', 'DELETE'] });

  app.register(rateLimit, {
    max: 120, timeWindow: '1 minute',
    // logged-in users are limited per account, everyone else per IP
    keyGenerator: (req) => (req.headers.authorization ? req.headers.authorization.slice(-32) : req.ip),
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'invalid_input', issues: err.issues });
    if (err instanceof AppError) return reply.code(err.status).send({ error: err.code });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    req.log.error(err);
    return reply.code(500).send({ error: 'server_error' });
  });

  app.get('/health', async () => ({ ok: true }));
  app.register(statsRoutes, { prefix: '/api/stats' });
  app.register(userRoutes, { prefix: '/api' });          // /api/me, /api/players/:username
  app.register(encounterRoutes, { prefix: '/api/encounters' });
  app.register(leaderboardRoutes, { prefix: '/api/leaderboard' });
  app.register(dailyRoutes, { prefix: '/api/daily' });
  app.register(starRoutes, { prefix: '/api/stars' });
  app.register(avatarRoutes, { prefix: '/api/avatars' });
  app.register(referralRoutes, { prefix: '/api/referrals' });
  app.register(chatRoutes, { prefix: '/api/chat' });
  app.register(bachsWebhook, { prefix: '/api/webhooks' });

  return app;
}