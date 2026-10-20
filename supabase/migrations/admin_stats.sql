-- =====================================================================
-- /stats page: daily visit history + one read-only function that builds
-- every number on the page. Only the backend (service_role) can call it.
-- =====================================================================

-- The old counter only keeps a running total, so keep one row per day too.
create table if not exists public.site_visits_daily (
  day    date primary key,
  visits bigint not null default 0
);
alter table public.site_visits_daily enable row level security; -- no policies: API users cannot read it

-- Same behaviour as before (returns the new total), plus the daily row. Lagos time.
create or replace function public.increment_visits()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare total bigint;
begin
  insert into public.site_visits_daily (day, visits)
  values ((now() at time zone 'Africa/Lagos')::date, 1)
  on conflict (day) do update set visits = public.site_visits_daily.visits + 1;

  update public.site_counters set value = value + 1 where key = 'total_visits' returning value into total;
  return total;
end;
$$;

create or replace function public.admin_stats(p_days int default 30)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
with
win as (
  select greatest(1, least(coalesce(p_days, 30), 365)) as d,
         (now() at time zone 'Africa/Lagos')::date as today,
         (now() at time zone 'Africa/Lagos')::date - (greatest(1, least(coalesce(p_days, 30), 365)) - 1) as from_day
),
days as (
  select g::date as day from win, generate_series(win.from_day, win.today, interval '1 day') g
),
prof as (
  select id, username, is_guest, stars, streak, last_played_on, created_at,
         (created_at at time zone 'Africa/Lagos')::date as signup_day
  from profiles
),
enc as (
  select e.id, e.mode, e.format, e.status, e.scenario_id, e.is_daily, e.created_at, e.finished_at,
         (e.created_at at time zone 'Africa/Lagos')::date as day,
         extract(hour from e.created_at at time zone 'Africa/Lagos')::int as hr,
         extract(dow  from e.created_at at time zone 'Africa/Lagos')::int as dow
  from encounters e
),
-- a game only counts as "played" once somebody has actually rolled in it
started as (select distinct encounter_id as id from encounter_rolls),
plays as (
  select ep.user_id, ep.encounter_id, ep.result, e.day, e.mode
  from encounter_players ep
  join enc e on e.id = ep.encounter_id
  where exists (select 1 from encounter_rolls r where r.encounter_id = ep.encounter_id and r.user_id = ep.user_id)
),
first_play as (select user_id, min(day) as first_day from plays group by user_id),
rolls as (
  select r.encounter_id, r.round_no, r.user_id, r.scene_key, r.approach, r.die, r.total, r.tier, r.star_play,
         e.day, e.scenario_id, (r.tier in ('win', 'legendary')) as passed
  from encounter_rolls r join enc e on e.id = r.encounter_id
),
paid as (
  select user_id, amount_kobo, stars, (paid_at at time zone 'Africa/Lagos')::date as day
  from star_purchases where status = 'paid' and paid_at is not null
),
ledger as (
  select user_id, delta, reason, (created_at at time zone 'Africa/Lagos')::date as day from star_ledger
)
select jsonb_build_object(
  'generated_at', now(),
  'days',  (select d from win),
  'today', (select today from win),

  'totals', jsonb_build_object(
    'players',        (select count(*) from prof),
    'registered',     (select count(*) from prof where not is_guest),
    'guests',         (select count(*) from prof where is_guest),
    'signups_today',  (select count(*) from prof, win where signup_day = win.today),
    'signups_7d',     (select count(*) from prof, win where signup_day >= win.today - 6),
    'signups_30d',    (select count(*) from prof, win where signup_day >= win.today - 29),
    'signups_window', (select count(*) from prof, win where signup_day >= win.from_day),
    'dau',            (select count(distinct user_id) from plays, win where day = win.today),
    'wau',            (select count(distinct user_id) from plays, win where day >= win.today - 6),
    'mau',            (select count(distinct user_id) from plays, win where day >= win.today - 29),
    'players_window', (select count(distinct user_id) from plays, win where day >= win.from_day),
    'never_played',   (select count(*) from prof where id not in (select user_id from first_play)),
    'games_played',   (select count(*) from started),
    'games_today',    (select count(*) from enc, win where enc.day = win.today and enc.id in (select id from started)),
    'games_7d',       (select count(*) from enc, win where enc.day >= win.today - 6 and enc.id in (select id from started)),
    'games_window',   (select count(*) from enc, win where enc.day >= win.from_day and enc.id in (select id from started)),
    'lobbies_window', (select count(*) from enc, win where enc.day >= win.from_day),
    'finished',       (select count(*) from enc where status = 'finished'),
    'abandoned',      (select count(*) from enc where status = 'abandoned'),
    'waiting',        (select count(*) from enc where status = 'waiting'),
    'completion_rate',(select round(100.0 * count(*) filter (where status = 'finished') / nullif(count(*), 0), 1)
                         from enc where id in (select id from started)),
    'avg_game_minutes',(select round(avg(extract(epoch from finished_at - created_at) / 60)::numeric, 1)
                         from enc where status = 'finished' and finished_at is not null),
    'rolls',          (select count(*) from encounter_rolls),
    'avg_games_per_active_player', (select round(count(*)::numeric / nullif(count(distinct user_id), 0), 1) from plays),
    'visits_total',   (select value from site_counters where key = 'total_visits'),
    'visits_today',   coalesce((select visits from site_visits_daily, win where day = win.today), 0),
    'visits_window',  coalesce((select sum(visits) from site_visits_daily, win where day >= win.from_day), 0),
    'visits_tracked_since', (select min(day) from site_visits_daily)
  ),

  'series', (
    select jsonb_agg(jsonb_build_object(
      'day', dd.day,
      'visits',        coalesce((select visits from site_visits_daily v where v.day = dd.day), 0),
      'signups',       (select count(*) from prof where signup_day = dd.day),
      'guest_signups', (select count(*) from prof where signup_day = dd.day and is_guest),
      'active',        (select count(distinct user_id) from plays where plays.day = dd.day),
      'new_players',   (select count(*) from first_play where first_day = dd.day),
      'lobbies',       (select count(*) from enc where enc.day = dd.day),
      'games',         (select count(*) from enc where enc.day = dd.day and enc.id in (select id from started)),
      'finished',      (select count(*) from enc where enc.day = dd.day and enc.status = 'finished'),
      'rolls',         (select count(*) from rolls where rolls.day = dd.day),
      'by_mode',       (select coalesce(jsonb_object_agg(m.mode, m.c), '{}'::jsonb)
                          from (select mode, count(*) c from enc
                                where enc.day = dd.day and enc.id in (select id from started) group by mode) m),
      'revenue_kobo',  (select coalesce(sum(amount_kobo), 0) from paid where paid.day = dd.day)
    ) order by dd.day)
    from days dd
  ),

  'modes', (
    select coalesce(jsonb_agg(to_jsonb(t) order by t.lobbies desc), '[]'::jsonb) from (
      select e.mode, e.format,
             count(*) as lobbies,
             count(*) filter (where e.id in (select id from started)) as played,
             count(*) filter (where e.status = 'finished')  as finished,
             count(*) filter (where e.status = 'abandoned') as abandoned,
             count(*) filter (where e.status = 'waiting')   as waiting,
             count(*) filter (where e.is_daily)             as daily
      from enc e, win where e.day >= win.from_day
      group by e.mode, e.format
    ) t
  ),

  'coop_outcomes', (
    select jsonb_build_object(
      'success', count(distinct encounter_id) filter (where result = 'success'),
      'fail',    count(distinct encounter_id) filter (where result = 'fail'))
    from plays, win where mode = 'coop' and day >= win.from_day
  ),

  'scenarios', (
    select coalesce(jsonb_agg(to_jsonb(t) order by t.played desc, t.lobbies desc), '[]'::jsonb) from (
      select e.scenario_id,
             count(*) as lobbies,
             count(*) filter (where e.id in (select id from started)) as played,
             count(*) filter (where e.status = 'finished')  as finished,
             count(*) filter (where e.status = 'abandoned') as abandoned,
             round((avg(extract(epoch from e.finished_at - e.created_at) / 60)
                    filter (where e.status = 'finished' and e.finished_at is not null))::numeric, 1) as avg_minutes,
             (select round(100.0 * count(*) filter (where r.passed) / nullif(count(*), 0), 1)
                from rolls r, win w2 where r.scenario_id = e.scenario_id and r.day >= w2.from_day) as pass_rate
      from enc e, win where e.day >= win.from_day
      group by e.scenario_id
    ) t
  ),

  'scenes', (
    select coalesce(jsonb_agg(to_jsonb(t) order by t.rolls desc), '[]'::jsonb) from (
      select r.scenario_id, r.scene_key,
             count(*) as rolls,
             count(distinct r.encounter_id) as games,
             round(100.0 * count(*) filter (where r.passed) / count(*), 1) as pass_rate,
             round(avg(r.die)::numeric, 1) as avg_die
      from rolls r, win where r.day >= win.from_day
      group by r.scenario_id, r.scene_key
      order by count(*) desc
      limit 40
    ) t
  ),

  'approaches', (
    select coalesce(jsonb_agg(to_jsonb(t) order by t.picks desc), '[]'::jsonb) from (
      select r.approach,
             count(*) as picks,
             round(100.0 * count(*) filter (where r.passed) / count(*), 1) as pass_rate,
             round(avg(r.die)::numeric, 1) as avg_die
      from rolls r, win where r.day >= win.from_day
      group by r.approach
    ) t
  ),

  'tiers', (
    select coalesce(jsonb_agg(to_jsonb(t) order by t.n desc), '[]'::jsonb) from (
      select r.tier, count(*) as n from rolls r, win where r.day >= win.from_day group by r.tier
    ) t
  ),

  'star_plays', (
    select jsonb_build_object(
      'rolls', count(*),
      'with_star_play', count(*) filter (where star_play is not null),
      'by_type', coalesce((select jsonb_object_agg(x.star_play, x.n) from (
                    select star_play, count(*) n from rolls r2, win w2
                    where r2.day >= w2.from_day and r2.star_play is not null group by star_play) x), '{}'::jsonb))
    from rolls, win where rolls.day >= win.from_day
  ),

  'hours', (
    select jsonb_agg(coalesce(x.c, 0) order by g.h)
    from generate_series(0, 23) as g(h)
    left join (select hr, count(*) c from enc, win
               where enc.day >= win.from_day and enc.id in (select id from started) group by hr) x on x.hr = g.h
  ),
  'weekdays', (
    select jsonb_agg(coalesce(x.c, 0) order by g.h)
    from generate_series(0, 6) as g(h)
    left join (select dow, count(*) c from enc, win
               where enc.day >= win.from_day and enc.id in (select id from started) group by dow) x on x.dow = g.h
  ),

  -- where lobbies are lost: 0 = left before the first roll
  'abandon_by_round', (
    select coalesce(jsonb_agg(to_jsonb(t) order by t.round), '[]'::jsonb) from (
      select coalesce(m.mr, 0)::int as round, count(*) as games
      from enc e
      left join (select encounter_id, max(round_no) mr from encounter_rolls group by encounter_id) m on m.encounter_id = e.id,
           win
      where e.status = 'abandoned' and e.day >= win.from_day
      group by 1
    ) t
  ),

  'funnel', jsonb_build_array(
    jsonb_build_object('step', 'Signed up',               'n', (select count(*) from prof)),
    jsonb_build_object('step', 'Played a game',           'n', (select count(*) from first_play)),
    jsonb_build_object('step', 'Finished a game',         'n', (select count(distinct user_id) from plays where result is not null)),
    jsonb_build_object('step', 'Played on 2+ days',       'n', (select count(*) from (select user_id from plays group by user_id having count(distinct day) >= 2) z)),
    jsonb_build_object('step', 'Bought stars',            'n', (select count(distinct user_id) from paid))
  ),

  'retention', jsonb_build_object(
    'eligible_d1', (select count(*) from first_play, win where first_day <= win.today - 1),
    'd1', (select count(*) from first_play f, win where f.first_day <= win.today - 1
             and exists (select 1 from plays p where p.user_id = f.user_id and p.day = f.first_day + 1)),
    'eligible_d7', (select count(*) from first_play, win where first_day <= win.today - 7),
    'd7', (select count(*) from first_play f, win where f.first_day <= win.today - 7
             and exists (select 1 from plays p where p.user_id = f.user_id and p.day between f.first_day + 1 and f.first_day + 7))
  ),

  'engagement', (
    select coalesce(jsonb_agg(jsonb_build_object('bucket', b.label, 'players', b.n) order by b.ord), '[]'::jsonb) from (
      select case when g = 0 then 1 when g = 1 then 2 when g <= 4 then 3 when g <= 9 then 4 else 5 end as ord,
             case when g = 0 then '0 games' when g = 1 then '1 game' when g <= 4 then '2-4 games'
                  when g <= 9 then '5-9 games' else '10+ games' end as label,
             count(*) as n
      from (select pr.id, (select count(distinct encounter_id) from plays p where p.user_id = pr.id) as g from prof pr) q
      group by 1, 2
    ) b
  ),

  'streaks', jsonb_build_object(
    'none',  (select count(*) from prof where streak = 0),
    'd1_2',  (select count(*) from prof where streak between 1 and 2),
    'd3_6',  (select count(*) from prof where streak between 3 and 6),
    'd7_plus', (select count(*) from prof where streak >= 7)
  ),

  'stars', jsonb_build_object(
    'in_circulation', (select coalesce(sum(stars), 0) from prof),
    'earned_window',  (select coalesce(sum(delta) filter (where delta > 0), 0) from ledger, win where day >= win.from_day),
    'spent_window',   (select coalesce(-sum(delta) filter (where delta < 0), 0) from ledger, win where day >= win.from_day),
    'by_reason', (
      select coalesce(jsonb_agg(to_jsonb(t) order by t.events desc), '[]'::jsonb) from (
        select reason, count(*) as events,
               coalesce(sum(delta) filter (where delta > 0), 0) as earned,
               coalesce(-sum(delta) filter (where delta < 0), 0) as spent
        from ledger, win where day >= win.from_day group by reason
      ) t
    )
  ),

  'revenue', jsonb_build_object(
    'paid_orders',   (select count(*) from paid),
    'buyers',        (select count(distinct user_id) from paid),
    'total_kobo',    (select coalesce(sum(amount_kobo), 0) from paid),
    'window_kobo',   (select coalesce(sum(amount_kobo), 0) from paid, win where paid.day >= win.from_day),
    'pending_orders',(select count(*) from star_purchases where status = 'pending')
  ),

  'social', jsonb_build_object(
    'chat_requests',          (select count(*) from chat_requests),
    'chat_requests_accepted', (select count(*) from chat_requests where status = 'accepted'),
    'chat_requests_pending',  (select count(*) from chat_requests where status = 'pending'),
    'conversations',          (select count(*) from conversations),
    'messages',               (select count(*) from messages),
    'messages_window',        (select count(*) from messages, win where (created_at at time zone 'Africa/Lagos')::date >= win.from_day),
    'referrals',              (select count(*) from referrals),
    'referrals_rewarded',     (select count(*) from referrals where rewarded_at is not null),
    'reports',                (select count(*) from reports),
    'blocks',                 (select count(*) from blocks)
  ),

  'recent_players', (
    select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at desc), '[]'::jsonb) from (
      select pr.username, pr.is_guest, pr.created_at, pr.last_played_on, pr.stars, pr.streak,
             (select count(distinct encounter_id) from plays p where p.user_id = pr.id) as games
      from prof pr order by pr.created_at desc limit 20
    ) t
  ),
  'top_players', (
    select coalesce(jsonb_agg(to_jsonb(t) order by t.games desc, t.score desc), '[]'::jsonb) from (
      select pr.username, pr.is_guest, ps.encounters_played as games, ps.wins, ps.losses, ps.score, pr.last_played_on
      from player_stats ps join prof pr on pr.id = ps.user_id
      order by ps.encounters_played desc, ps.score desc limit 15
    ) t
  )
);
$$;

-- Nobody but the backend (service role) may run it.
revoke all on function public.admin_stats(int) from public, anon, authenticated;
grant execute on function public.admin_stats(int) to service_role;
