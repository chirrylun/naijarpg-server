import type { Socket } from 'socket.io';
import { z } from 'zod';
import { handle } from '../../realtime/handle';
import { AppError } from '../../lib/errors';
import { APPROACHES } from '../../game-engine/types';
import { joinQueue, leaveQueue } from './matchmaking';
import { joinRoom, requestRematch, roomByCode, rooms, submitAction, leaveRoom } from './rooms';

export function registerEncounterSockets(socket: Socket) {
  handle(socket, 'queue:join',
    z.object({ mode: z.enum(['rival', 'coop', 'team']), format: z.enum(['1v1', '2v2']), daily: z.boolean().optional() }),
    (uid, d) => joinQueue(uid, d.mode, d.format, !!d.daily));

  handle(socket, 'queue:leave', z.object({}), async (uid) => { leaveQueue(uid); });

  handle(socket, 'room:join', z.object({ code: z.string().min(4).max(10) }), async (uid, d) => {
    const room = rooms.get(roomByCode.get(d.code.toUpperCase()) ?? '');
    if (!room) throw new AppError(404, 'invite_not_found');
    await joinRoom(room, uid);
    return { roomId: room.id };
  });

  handle(socket, 'round:submit',
    z.object({ approach: z.enum(APPROACHES), star: z.enum(['reroll', 'nudge', 'shield']).optional() }),
    async (uid, d) => { submitAction(uid, d.approach, d.star); },
    { max: 10, windowMs: 10_000 });

  handle(socket, 'rematch:request', z.object({ roomId: z.string().uuid() }), (uid, d) => requestRematch(uid, d.roomId));

  handle(socket, 'room:leave', z.object({}), async (uid) => { await leaveRoom(uid); });
}