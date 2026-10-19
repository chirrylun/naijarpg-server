import { Server } from 'socket.io';
import { buildApp } from './app';
import { registerRealtime } from './realtime';
import { setIo } from './realtime/context';
import { ORIGINS, env } from './config/env';
import { sweepOrphanedGames } from './modules/encounters/rooms';

async function main() {
  const app = buildApp();
  await app.ready();

  const io = new Server(app.server, { cors: { origin: ORIGINS } });
  setIo(io);
  registerRealtime(io);

  await app.listen({ port: env.PORT, host: '0.0.0.0' });

  // Give entry stars back for games that were cut off by a restart (checked now, then every 10 minutes)
  void sweepOrphanedGames();
  setInterval(() => void sweepOrphanedGames(), 10 * 60_000).unref();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});