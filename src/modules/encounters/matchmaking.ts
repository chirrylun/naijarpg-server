import { AppError } from '../../lib/errors';
import type { Format, Mode } from '../../game-engine/types';
import { createRoom, joinRoom, roomOfUser } from './rooms';

const queues = new Map<string, string[]>();

/** People waiting for an opponent, per queue (for the /stats page) */
export const queueSizes = () =>
  [...queues].map(([key, q]) => ({ key, waiting: q.length })).filter((x) => x.waiting > 0);

export function leaveQueue(userId: string) {
  for (const [k, q] of queues) queues.set(k, q.filter((id) => id !== userId));
}

export async function joinQueue(userId: string, mode: Mode, format: Format, daily: boolean) {
  if (roomOfUser.has(userId)) throw new AppError(409, 'already_in_encounter');
  leaveQueue(userId);
  const key = `${mode}:${format}:${daily ? 'daily' : 'any'}`;
  const q = queues.get(key) ?? [];
  q.push(userId);
  queues.set(key, q);
  const need = format === '1v1' ? 2 : 4;
  if (q.length < need) return { matched: false };
  const group = q.splice(0, need);
  const room = await createRoom({ hostId: group[0], mode, format, daily });
  for (const id of group) await joinRoom(room, id);
  return { matched: true, roomId: room.id };
}