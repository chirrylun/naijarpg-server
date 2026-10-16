import type { Server, Socket } from 'socket.io';
import { userFromToken } from '../middleware/auth';
import { addPresence, removePresence, liveCount } from './presence'
import { registerEncounterSockets } from '../modules/encounters/encounters.socket';
import { registerChatSockets } from '../modules/chat/chat.socket';
import { leaveQueue } from '../modules/encounters/matchmaking';
import { emitState, roomOfUser, rooms, sendPrivate } from '../modules/encounters/rooms';

async function authenticate(socket: Socket, token?: string) {
  const user = await userFromToken(token);
  if (!user) return null;
  socket.data.userId = user.id;
  socket.join(`user:${user.id}`); // personal room: chat, star updates, etc.
  const roomId = roomOfUser.get(user.id); // reconnect mid-game: put them back in
  const room = roomId ? rooms.get(roomId) : undefined;
if (room) { socket.join(`room:${room.id}`); emitState(room); sendPrivate(room, user.id); }
  return { userId: user.id, roomId: room?.id ?? null };
}

export function registerRealtime(io: Server) {
  let timer: NodeJS.Timeout | null = null;
  const broadcastLive = () => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; io.emit('stats:live', { liveUsers: liveCount() }); }, 1000);
  };

  io.on('connection', async (socket) => {
    const raw = socket.handshake.auth?.visitorId;
    const visitorId = typeof raw === 'string' && raw.length > 0 ? raw.slice(0, 64) : socket.id;
    addPresence(visitorId, socket.id);
    socket.emit('stats:live', { liveUsers: liveCount() });
    broadcastLive();

    // Visitors can connect anonymously (landing page). They log in to the socket when they have a session.
    socket.on('auth:login', async (payload: { token?: string }, ack?: (r: unknown) => void) => {
      const res = await authenticate(socket, payload?.token);
      ack?.(res ? { ok: true, ...res } : { ok: false, error: 'unauthorized' });
    });
    if (typeof socket.handshake.auth?.token === 'string') await authenticate(socket, socket.handshake.auth.token);

    registerEncounterSockets(socket);
    registerChatSockets(socket);

    socket.on('disconnect', async () => {
      removePresence(visitorId, socket.id);
      broadcastLive();
      const uid = socket.data.userId as string | undefined;
      if (uid && (await io.in(`user:${uid}`).fetchSockets()).length === 0) leaveQueue(uid);
    });
  });
}