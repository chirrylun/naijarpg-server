import type { Socket } from 'socket.io';
import { z, ZodError } from 'zod';
import { AppError } from '../lib/errors';
import { allow } from '../lib/rate';

export function handle<T extends z.ZodTypeAny>(
  socket: Socket,
  event: string,
  schema: T,
  fn: (userId: string, data: z.infer<T>) => Promise<unknown>,
  limit = { max: 20, windowMs: 10_000 },
) {
  socket.on(event, async (payload: unknown, ack?: (r: unknown) => void) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    try {
      const userId = socket.data.userId as string | undefined;
      if (!userId) throw new AppError(401, 'unauthorized');
      if (!allow(`${userId}:${event}`, limit.max, limit.windowMs)) throw new AppError(429, 'slow_down');
      const data = schema.parse(payload ?? {});
      reply({ ok: true, data: await fn(userId, data) });
    } catch (e) {
      const known = e instanceof AppError || e instanceof ZodError;
      reply({ ok: false, error: e instanceof AppError ? e.code : e instanceof ZodError ? 'invalid_input' : 'server_error' });
      if (!known) console.error(`[${event}]`, e);
    }
  });
}