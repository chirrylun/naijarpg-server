-- Keep profiles.is_guest in step with auth.users.is_anonymous.
--
-- When a guest confirms their email, Supabase flips auth.users.is_anonymous to false.
-- Until now profiles.is_guest was only updated if the browser that clicked the link also
-- managed to call POST /api/me/sync. If that call failed (cold server, network, link opened
-- in another app) the player stayed a "guest" in the UI even though the account was saved.
-- This trigger makes the database the source of truth.

create function public.handle_user_upgraded()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.profiles
  set is_guest = coalesce(new.is_anonymous, true)
  where id = new.id;
  return new;
end;
$$;

create trigger on_auth_user_upgraded
after update of is_anonymous on auth.users
for each row
when (old.is_anonymous is distinct from new.is_anonymous)
execute function public.handle_user_upgraded();

-- Backfill: accounts that already confirmed their email but are still flagged as guests.
update public.profiles p
set is_guest = false
from auth.users u
where u.id = p.id
  and u.is_anonymous = false
  and p.is_guest = true;
