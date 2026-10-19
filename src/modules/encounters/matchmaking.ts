import { AppError } from '../../lib/errors';
import { getIo } from '../../realtime/context';
import type { Format, Mode } from '../../game-engine/types';
import { assertCanAfford, createRoom, entryCostFor, joinRoom, playersShort, roomOfUser } from './rooms';

const queues = new Map<string, string[]>();

export function leaveQueue(userId: string) {
  for (const [k, q] of queues) queues.set(k, q.filter((id) => id !== userId));
}

export async function joinQueue(userId: string, mode: Mode, format: Format, daily: boolean) {
  if (roomOfUser.has(userId)) throw new AppError(409, 'already_in_encounter');
  const cost = entryCostFor(mode, false);
  await assertCanAfford(userId, cost); // no point queueing if you can't pay the entry
  leaveQueue(userId);
  const key = `${mode}:${format}:${daily ? 'daily' : 'any'}`;
  const q = queues.get(key) ?? [];
  q.push(userId);
  queues.set(key, q);
  const need = format === '1v1' ? 2 : 4;
  if (q.length < need) return { matched: false };
  const group = q.splice(0, need);

  // Somebody may have spent their stars while waiting. Check again now that a match is real:
  // the ones who can still pay keep their place, the others are told to go back.
  const short = await playersShort(group, cost);
  if (short.length) {
    const ok = group.filter((id) => !short.includes(id));
    queues.set(key, [...ok, ...q]);
    for (const id of short) if (id !== userId) getIo().to(`user:${id}`).emit('room:aborted', { reason: 'not_enough_stars', refunded: false });
    if (short.includes(userId)) throw new AppError(402, 'not_enough_stars');
    return { matched: false };
  }

  const room = await createRoom({ hostId: group[0], mode, format, daily });
  for (const id of group) await joinRoom(room, id);
  return { matched: true, roomId: room.id };
}
