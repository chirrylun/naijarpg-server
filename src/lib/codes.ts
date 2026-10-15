import { randomBytes } from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I confusion
export const makeCode = (len = 6) =>
  Array.from(randomBytes(len), (b) => ALPHABET[b % ALPHABET.length]).join('');