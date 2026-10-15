import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../../middleware/auth';
import * as chat from './chat.service';

const user = z.object({ username: z.string().min(3).max(16) });

export async function chatRoutes(app: FastifyInstance) {
  const auth = { onRequest: requireUser };
  app.post('/requests', auth, async (req) => chat.sendRequest(req.userId, user.parse(req.body).username));
  app.get('/requests', auth, async (req) => chat.incomingRequests(req.userId));
  app.post('/requests/:id/respond', auth, async (req) =>
    chat.respond(req.userId, (req.params as { id: string }).id, z.object({ accept: z.boolean() }).parse(req.body).accept));
  app.get('/conversations', auth, async (req) => chat.listConversations(req.userId));
  app.get('/conversations/:id/messages', auth, async (req) => {
    const before = z.coerce.number().optional().parse((req.query as any).before);
    return chat.listMessages(req.userId, (req.params as { id: string }).id, before);
  });
  app.post('/block', auth, async (req) => chat.blockUser(req.userId, user.parse(req.body).username));
  app.post('/report', auth, async (req) => {
    const b = user.extend({ reason: z.string().min(1).max(300), messageId: z.number().optional() }).parse(req.body);
    return chat.reportUser(req.userId, b.username, b.reason, b.messageId);
  });
}