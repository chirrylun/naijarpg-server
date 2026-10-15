import type { FastifyInstance } from 'fastify';
import { dailyScenario } from '../../content';
import { lagosDate } from '../../lib/time';

export async function dailyRoutes(app: FastifyInstance) {
  app.get('/', async () => {
    const s = dailyScenario();
    return { date: lagosDate(), scenario: { id: s.id, title: s.title, tagline: s.tagline, modes: s.modes } };
  });
}