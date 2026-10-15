import type { Socket } from 'socket.io';
import { z } from 'zod';
import { handle } from '../../realtime/handle';
import { sendMessage } from './chat.service';

export function registerChatSockets(socket: Socket) {
  handle(socket, 'dm:send',
    z.object({ conversationId: z.string().uuid(), body: z.string().min(1).max(500) }),
    (uid, d) => sendMessage(uid, d.conversationId, d.body));
}