import type { FastifyReply, FastifyRequest } from 'fastify';
import { supabase } from '../db/supabase'

declare module 'fastify' {
  interface FastifyRequest { userId: string; authEmail: string | null; isAnonymous: boolean }
}

export async function userFromToken(token?: string) {
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  return error || !data.user ? null : data.user;
}

export async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  const user = await userFromToken(req.headers.authorization?.replace('Bearer ', ''));
  if (!user) return reply.code(401).send({ error: 'unauthorized' });
  req.userId = user.id;
  req.authEmail = user.email ?? null;
  req.isAnonymous = !!user.is_anonymous;
}