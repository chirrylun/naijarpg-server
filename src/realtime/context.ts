import type { Server } from 'socket.io';
let io: Server;
export const setIo = (s: Server) => { io = s; };
export const getIo = () => io;