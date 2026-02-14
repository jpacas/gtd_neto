-- GTD_Neto Improved Supabase Schema
-- Version: 2.0
-- Date: 2026-02-14
--
-- IMPROVEMENTS:
-- 1. Real RLS policies (user-scoped access)
-- 2. JSONB indexes for common queries
-- 3. Optimized composite indexes
-- 4. Better security model

-- =============================================================================
-- TABLE DEFINITION
-- =============================================================================

create table if not exists public.gtd_items (
  id text not null,
  owner text not null,
  payload jsonb not null,
  updated_at timestamptz not null default now(),

  -- Primary key: composite (id, owner) for multi-tenant isolation
  -- NOTE: If your app guarantees globally unique IDs, you can use just 'id'
  primary key (id, owner)
);

-- =============================================================================
-- INDEXES
-- =============================================================================

-- Core index for listing items by user and recency
create index if not exists idx_gtd_items_owner_updated
  on public.gtd_items(owner, updated_at desc);

-- JSONB indexes for common query patterns
-- These significantly speed up WHERE clauses on payload fields

-- Index for filtering by list (collect, hacer, agendar, etc.)
create index if not exists idx_gtd_items_payload_list
  on public.gtd_items using gin ((payload -> 'list'));

-- Index for filtering by status (unprocessed, done, etc.)
create index if not exists idx_gtd_items_payload_status
  on public.gtd_items using gin ((payload -> 'status'));

-- Composite index for list + status queries (most common)
create index if not exists idx_gtd_items_payload_list_status
  on public.gtd_items using btree (owner, (payload ->> 'list'), (payload ->> 'status'));

-- Index for date-based queries (scheduledFor, delegatedFor)
create index if not exists idx_gtd_items_payload_scheduled
  on public.gtd_items using btree (owner, (payload ->> 'scheduledFor'))
  where (payload ->> 'scheduledFor') is not null;

-- Full-text search index on input/title fields (optional, for future search)
create index if not exists idx_gtd_items_payload_search
  on public.gtd_items using gin (
    to_tsvector('spanish', coalesce(payload ->> 'input', '') || ' ' || coalesce(payload ->> 'title', ''))
  );

-- =============================================================================
-- ROW LEVEL SECURITY (RLS)
-- =============================================================================

-- Enable RLS on the table
alter table public.gtd_items enable row level security;

-- Drop the old permissive policy if it exists
drop policy if exists allow_all_temp on public.gtd_items;

-- POLICY 1: Users can only see their own items
-- This policy applies to SELECT queries
create policy user_own_items_select on public.gtd_items
  for select
  using (
    owner = coalesce(
      current_setting('request.jwt.claims', true)::json->>'sub',
      'default'
    )::text
  );

-- POLICY 2: Users can only insert items with their own owner ID
create policy user_own_items_insert on public.gtd_items
  for insert
  with check (
    owner = coalesce(
      current_setting('request.jwt.claims', true)::json->>'sub',
      'default'
    )::text
  );

-- POLICY 3: Users can only update their own items
create policy user_own_items_update on public.gtd_items
  for update
  using (
    owner = coalesce(
      current_setting('request.jwt.claims', true)::json->>'sub',
      'default'
    )::text
  )
  with check (
    owner = coalesce(
      current_setting('request.jwt.claims', true)::json->>'sub',
      'default'
    )::text
  );

-- POLICY 4: Users can only delete their own items
create policy user_own_items_delete on public.gtd_items
  for delete
  using (
    owner = coalesce(
      current_setting('request.jwt.claims', true)::json->>'sub',
      'default'
    )::text
  );

-- =============================================================================
-- FUNCTIONS & TRIGGERS
-- =============================================================================

-- Function to automatically update updated_at timestamp
create or replace function public.update_gtd_items_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql security definer;

-- Trigger to call the function before updates
drop trigger if exists trigger_update_gtd_items_updated_at on public.gtd_items;
create trigger trigger_update_gtd_items_updated_at
  before update on public.gtd_items
  for each row
  execute function public.update_gtd_items_updated_at();

-- =============================================================================
-- PERFORMANCE TUNING
-- =============================================================================

-- Analyze the table to update statistics (helps query planner)
analyze public.gtd_items;

-- =============================================================================
-- GRANTS (for service_role and authenticated users)
-- =============================================================================

-- Grant access to authenticated users (policies control what they can see)
grant select, insert, update, delete on public.gtd_items to authenticated;

-- Grant access to anon users if you want public read access (uncomment if needed)
-- grant select on public.gtd_items to anon;

-- =============================================================================
-- MIGRATION NOTES
-- =============================================================================

-- If you're migrating from the old schema:
--
-- 1. BACKUP FIRST:
--    pg_dump -h your-db.supabase.co -U postgres -d postgres -t public.gtd_items > backup.sql
--
-- 2. If you have existing data, you need to migrate the primary key:
--
--    -- Create new table with improved schema
--    create table public.gtd_items_new (like public.gtd_items including all);
--
--    -- Copy data
--    insert into public.gtd_items_new select * from public.gtd_items;
--
--    -- Swap tables
--    alter table public.gtd_items rename to gtd_items_old;
--    alter table public.gtd_items_new rename to gtd_items;
--
--    -- Drop old table after verifying
--    drop table public.gtd_items_old;
--
-- 3. The PRIMARY KEY change (id -> id, owner) is OPTIONAL:
--    - If your app generates globally unique IDs, keep primary key as just 'id'
--    - If multiple users might have same ID, use composite (id, owner)
--    - Current code works with either approach

-- =============================================================================
-- VERIFICATION QUERIES
-- =============================================================================

-- Check policies are active:
-- select * from pg_policies where tablename = 'gtd_items';

-- Check indexes:
-- select indexname, indexdef from pg_indexes where tablename = 'gtd_items';

-- Test query performance (should use indexes):
-- explain analyze select * from gtd_items where owner = 'test' and payload->>'list' = 'hacer';
