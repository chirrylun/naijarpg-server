-- PROFILES (one per auth user, including anonymous guests)
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  avatar jsonb not null default '{}'::jsonb,
  is_guest boolean not null default true,
  created_at timestamptz not null default now()
);

-- PLAYER STATS (feeds the leaderboard)
create table public.player_stats (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  score integer not null default 0,
  wins integer not null default 0,
  losses integer not null default 0,
  encounters_played integer not null default 0,
  updated_at timestamptz not null default now()
);
create index player_stats_rank_idx on public.player_stats (score desc, wins desc);

-- SITE COUNTERS (total visits)
create table public.site_counters (
  key text primary key,
  value bigint not null default 0
);
insert into public.site_counters (key, value) values ('total_visits', 0);

create function public.increment_visits()
returns bigint
language sql
security definer
set search_path = public
as $$
  update public.site_counters
  set value = value + 1
  where key = 'total_visits'
  returning value;
$$;

revoke execute on function public.increment_visits() from public, anon, authenticated;
grant execute on function public.increment_visits() to service_role;

-- AUTO-CREATE profile + stats whenever a user (or guest) is created
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, username, is_guest)
  values (
    new.id,
    'player_' || substr(replace(new.id::text, '-', ''), 1, 8),
    coalesce(new.is_anonymous, true)
  );
  insert into public.player_stats (user_id) values (new.id);
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- ROW LEVEL SECURITY
alter table public.profiles enable row level security;
alter table public.player_stats enable row level security;
alter table public.site_counters enable row level security;

create policy "profiles are public to read"
  on public.profiles for select using (true);

create policy "stats are public to read"
  on public.player_stats for select using (true);