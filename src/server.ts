import { Server } from 'socket.io';
import { buildApp } from './app';
import { registerRealtime } from './realtime';
import { setIo } from './realtime/context';
import { ORIGINS, env } from './config/env';

async function main() {
  const app = buildApp();
  await app.ready();

  const io = new Server(app.server, { cors: { origin: ORIGINS } });
  setIo(io);
  registerRealtime(io);

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});