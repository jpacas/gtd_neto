-- GTD_Neto minimal persistence schema (single-table payload strategy)
-- Run in Supabase SQL Editor

create table if not exists public.gtd_items (
  id text primary key,
  owner text not null default 'default',
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

create index if not exists idx_gtd_items_owner_updated
  on public.gtd_items(owner, updated_at desc);

-- Optional RLS for future auth model (currently service-role server writes)
alter table public.gtd_items enable row level security;

-- Keep policy permissive for now if you plan to query with anon key later.
-- For server-side with service role only, policies are bypassed.
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='gtd_items' and policyname='allow_all_temp'
  ) then
    create policy allow_all_temp on public.gtd_items for all using (true) with check (true);
  end if;
end$$;
