-- PROFILE ADDITIONS
alter table public.profiles
  add column stats jsonb not null default '{"charm":1,"hustle":1,"gragra":1,"wisdom":1}',
  add column stars integer not null default 5 check (stars >= 0),
  add column streak integer not null default 0,
  add column last_played_on date,
  add column referral_code text unique,
  add column title text;

alter table public.profiles alter column avatar set default
  '{"body":"body_1","outfit":"outfit_tee","headwear":"headwear_cap","shoes":"shoes_sneakers"}'::jsonb;

update public.profiles set referral_code = upper(substr(md5(id::text), 1, 8)) where referral_code is null;
update public.profiles set avatar = '{"body":"body_1","outfit":"outfit_tee","headwear":"headwear_cap","shoes":"shoes_sneakers"}'::jsonb where avatar = '{}'::jsonb;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username, is_guest, referral_code)
  values (
    new.id,
    'player_' || substr(replace(new.id::text, '-', ''), 1, 8),
    coalesce(new.is_anonymous, true),
    upper(substr(md5(new.id::text), 1, 8))
  );
  insert into public.player_stats (user_id) values (new.id);
  return new;
end; $$;

-- Profiles hold star balances and referral codes, so they are no longer readable
-- from the browser. All reads go through the server.
drop policy "profiles are public to read" on public.profiles;

-- STARS LEDGER
create table public.star_ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  delta integer not null,
  reason text not null,
  ref_id text,
  created_at timestamptz not null default now()
);
create unique index star_ledger_idem on public.star_ledger (user_id, reason, ref_id) where ref_id is not null;

create function public.apply_stars(p_user uuid, p_delta integer, p_reason text, p_ref text default null)
returns integer language plpgsql security definer set search_path = public as $$
declare bal integer;
begin
  -- repeat call with same reference = no double credit/charge
  if p_ref is not null and exists (
    select 1 from star_ledger where user_id = p_user and reason = p_reason and ref_id = p_ref
  ) then
    select stars into bal from profiles where id = p_user;
    return bal;
  end if;
  update profiles set stars = stars + p_delta where id = p_user and stars + p_delta >= 0 returning stars into bal;
  if bal is null then raise exception 'insufficient_stars'; end if;
  insert into star_ledger (user_id, delta, reason, ref_id) values (p_user, p_delta, p_reason, p_ref);
  return bal;
end; $$;

create table public.star_purchases (
  reference text primary key,
  user_id uuid not null references public.profiles(id),
  pack_id text not null,
  stars integer not null,
  amount_kobo integer not null,
  status text not null default 'pending' check (status in ('pending','paid')),
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

-- ENCOUNTERS
create table public.encounters (
  id uuid primary key default gen_random_uuid(),
  mode text not null check (mode in ('rival','coop','team')),
  format text not null check (format in ('1v1','2v2')),
  status text not null default 'waiting' check (status in ('waiting','active','finished','abandoned')),
  scenario_id text not null,
  invite_code text unique,
  is_daily boolean not null default false,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  outcome jsonb
);

create table public.encounter_players (
  encounter_id uuid references public.encounters(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete cascade,
  team smallint not null default 0,
  result text check (result in ('win','loss','draw','success','fail')),
  score_delta integer not null default 0,
  primary key (encounter_id, user_id)
);
create index on public.encounter_players (user_id);

create table public.encounter_rolls (
  id bigint generated always as identity primary key,
  encounter_id uuid not null references public.encounters(id) on delete cascade,
  round_no smallint not null,
  user_id uuid not null references public.profiles(id),
  scene_key text not null,
  approach text not null,
  die smallint not null,
  modifier smallint not null,
  star_play text,
  star_bonus smallint not null default 0,
  total smallint not null,
  tier text not null
);
create index on public.encounter_rolls (encounter_id);

-- WEEKLY LEADERBOARD
create table public.weekly_scores (
  season text not null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  score integer not null default 0,
  wins integer not null default 0,
  primary key (season, user_id)
);
create index on public.weekly_scores (season, score desc);

create function public.record_result(p_user uuid, p_season text, p_points integer, p_won boolean)
returns void language sql security definer set search_path = public as $$
  update player_stats set
    score = score + p_points,
    wins = wins + (case when p_won then 1 else 0 end),
    losses = losses + (case when p_won then 0 else 1 end),
    encounters_played = encounters_played + 1,
    updated_at = now()
  where user_id = p_user;
  insert into weekly_scores (season, user_id, score, wins)
  values (p_season, p_user, p_points, case when p_won then 1 else 0 end)
  on conflict (season, user_id) do update
    set score = weekly_scores.score + excluded.score, wins = weekly_scores.wins + excluded.wins;
$$;

-- CHAT (consent based)
create table public.chat_requests (
  id uuid primary key default gen_random_uuid(),
  from_user uuid not null references public.profiles(id) on delete cascade,
  to_user uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','accepted','declined')),
  created_at timestamptz not null default now(),
  responded_at timestamptz
);
create unique index chat_requests_one_pending on public.chat_requests (from_user, to_user) where status = 'pending';

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_a uuid not null references public.profiles(id) on delete cascade,
  user_b uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  check (user_a < user_b),
  unique (user_a, user_b)
);

create table public.messages (
  id bigint generated always as identity primary key,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 500),
  created_at timestamptz not null default now()
);
create index on public.messages (conversation_id, id desc);

create table public.blocks (
  blocker uuid references public.profiles(id) on delete cascade,
  blocked uuid references public.profiles(id) on delete cascade,
  primary key (blocker, blocked)
);

create table public.reports (
  id bigint generated always as identity primary key,
  reporter uuid not null references public.profiles(id) on delete cascade,
  reported uuid not null references public.profiles(id) on delete cascade,
  message_id bigint references public.messages(id) on delete set null,
  reason text,
  created_at timestamptz not null default now()
);

-- AVATARS
create table public.avatar_items (
  id text primary key,
  slot text not null check (slot in ('body','outfit','headwear','shoes')),
  name text not null,
  rarity text not null default 'common',
  price_stars integer not null default 0,
  is_default boolean not null default false,
  active boolean not null default true
);
create table public.user_items (
  user_id uuid references public.profiles(id) on delete cascade,
  item_id text references public.avatar_items(id),
  acquired_at timestamptz not null default now(),
  primary key (user_id, item_id)
);
insert into public.avatar_items (id, slot, name, rarity, price_stars, is_default) values
  ('body_1','body','Classic','common',0,true),
  ('outfit_tee','outfit','Plain Tee','common',0,true),
  ('outfit_ankara','outfit','Ankara Fit','rare',25,false),
  ('outfit_agbada','outfit','Agbada','epic',60,false),
  ('headwear_cap','headwear','Face Cap','common',0,true),
  ('headwear_gele','headwear','Gele','rare',25,false),
  ('shoes_sneakers','shoes','Sneakers','common',0,true),
  ('shoes_slippers','shoes','Bathroom Slippers','rare',15,false);

-- REFERRALS
create table public.referrals (
  referred_id uuid primary key references public.profiles(id) on delete cascade,
  referrer_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  rewarded_at timestamptz
);

-- LOCKDOWN: server-only functions, RLS on everything
revoke execute on function public.apply_stars(uuid, integer, text, text) from public, anon, authenticated;
revoke execute on function public.record_result(uuid, text, integer, boolean) from public, anon, authenticated;
grant execute on function public.apply_stars(uuid, integer, text, text) to service_role;
grant execute on function public.record_result(uuid, text, integer, boolean) to service_role;

alter table public.star_ledger enable row level security;
alter table public.star_purchases enable row level security;
alter table public.encounters enable row level security;
alter table public.encounter_players enable row level security;
alter table public.encounter_rolls enable row level security;
alter table public.weekly_scores enable row level security;
alter table public.chat_requests enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.blocks enable row level security;
alter table public.reports enable row level security;
alter table public.avatar_items enable row level security;
alter table public.user_items enable row level security;
alter table public.referrals enable row level security;

create policy "avatar items are public" on public.avatar_items for select using (true);
-- Everything else has no policy: only the server (service role) can read or write.