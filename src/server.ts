import { Server } from 'socket.io';
import { buildApp } from './app';
import { env } from './config/env';
import { registerRealtime } from './realtime';
import { setIo } from './realtime/context';

async function main() {
  const app = buildApp();
  await app.ready();

  const io = new Server(app.server, {
    cors: { origin: env.CLIENT_ORIGIN.split(',') },
  });
  setIo(io);
  registerRealtime(io);

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});