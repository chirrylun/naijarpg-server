import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { supabase } from '../../db/supabase'
import { WEB_URL } from '../../config/env';
import { AppError } from '../../lib/errors';
import { requireUser } from '../../middleware/auth';
import { assertCanAfford, createRoom, entryCostFor, joinRoom, rooms, roomByCode } from './rooms';

const inviteBody = z.object({
  mode: z.enum(['rival', 'coop', 'team']),
  format: z.enum(['1v1', '2v2']),
  daily: z.boolean().optional(),
});

export async function encounterRoutes(app: FastifyInstance) {
  // Create a challenge link
  app.post('/invite', { onRequest: requireUser }, async (req) => {
    const b = inviteBody.parse(req.body);
    if (b.mode === 'rival' && b.format === '2v2') throw new AppError(400, 'use_team_mode_for_2v2');
    await assertCanAfford(req.userId, entryCostFor(b.mode, false)); // check before a room is made, so no empty rooms are left behind
    const room = await createRoom({ hostId: req.userId, ...b, invite: true });
    await joinRoom(room, req.userId);
    return { code: room.code, roomId: room.id, url: `${WEB_URL}/c/${room.code}` };
  });

  // Public preview for the challenge landing page (/c/[code])
  app.get('/invite/:code', async (req) => {
    const code = (req.params as { code: string }).code.toUpperCase();
    const room = rooms.get(roomByCode.get(code) ?? '');
    if (!room) throw new AppError(404, 'invite_not_found');
    return {
      code, mode: room.mode, format: room.format, status: room.status,
      seatsLeft: room.capacity - room.players.length,
      host: room.players.find((p) => p.userId === room.hostId)?.username ?? null,
      scenario: { title: room.scenario.title, tagline: room.scenario.tagline },
    };
  });

  // Public result for share cards (/api/og)
  app.get('/:id/result', async (req) => {
    const { id } = req.params as { id: string };
    const { data, error } = await supabase
      .from('encounters')
      .select('id, mode, format, scenario_id, finished_at, outcome, encounter_players(team, result, score_delta, user_id)')
      .eq('id', id).eq('status', 'finished').maybeSingle();
    if (error) throw error;
    if (!data) throw new AppError(404, 'not_found');
    const ids = (data.encounter_players as { user_id: string }[]).map((p) => p.user_id);
    const { data: profs } = await supabase.from('profiles').select('id, username, avatar').in('id', ids);
    return { ...data, players: profs };
  });
}