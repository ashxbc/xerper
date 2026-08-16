-- Xerper NFT-discovery schema.
-- Run this once against your Supabase project (SQL Editor, or `supabase db push`
-- with the CLI). It is idempotent - safe to re-run.

-- Every NFT project the discovery scan has ever surfaced.
-- The dedup key is the lowercased handle: a handle is judged once, and any
-- later run that turns up the same handle skips it as a duplicate.
create table if not exists public.nft_projects (
  id bigint generated always as identity primary key,
  handle text not null,
  name text not null default '',
  avatar text not null default '',
  banner text not null default '',
  bio text not null default '',
  followers bigint not null default 0,
  following bigint not null default 0,
  verified boolean not null default false,
  joined text not null default '',
  recent_tweet text not null default '',
  is_nft_project boolean not null default true,
  source_query text not null default '',
  seen_in_post_url text not null default '',
  -- 'added' = accepted and published to the site, 'rejected' = judged false,
  -- 'discovered' = found but not yet acted on (reserved for manual flows).
  status text not null default 'discovered'
    check (status in ('discovered', 'added', 'rejected')),
  -- True once the system has fully handled this handle (i.e. it must never be
  -- re-added). Accepted projects are marked processed at insert time.
  processed boolean not null default false,
  discovered_at timestamptz not null default now(),
  added_at timestamptz,
  processed_at timestamptz,
  updated_at timestamptz not null default now()
);

-- Duplicate guard: X handles are case-insensitive, so uniqueness is enforced
-- on the lowercased handle.
create unique index if not exists nft_projects_handle_key
  on public.nft_projects (lower(handle));

create index if not exists nft_projects_status_idx
  on public.nft_projects (status);

create index if not exists nft_projects_discovered_at_idx
  on public.nft_projects (discovered_at desc);

-- One row per Gems Finding API call so there is a complete history of every
-- scheduled run. Each call is logged twice: a 'running' row is inserted the
-- moment the endpoint is invoked (so even a function killed mid-scan leaves a
-- trace), then updated to 'success'/'partial'/'failed' when the scan finishes.
create table if not exists public.gems_scan_logs (
  id bigint generated always as identity primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null check (status in ('running', 'success', 'partial', 'failed')),
  projects_found integer not null default 0,
  projects_new integer not null default 0,
  projects_skipped_duplicates integer not null default 0,
  projects_rejected integer not null default 0,
  candidates_considered integer not null default 0,
  queries_run integer not null default 0,
  posts_scanned integer not null default 0,
  rate_limited boolean not null default false,
  error text
);

create index if not exists gems_scan_logs_started_at_idx
  on public.gems_scan_logs (started_at desc);

-- For projects that already ran the original schema: widen the status check
-- to admit 'running' rows. Idempotent - safe to re-run.
alter table public.gems_scan_logs drop constraint if exists gems_scan_logs_status_check;
alter table public.gems_scan_logs add constraint gems_scan_logs_status_check
  check (status in ('running', 'success', 'partial', 'failed'));

-- Projects listed through the Telegram bot. These are NOT NFT-scan results -
-- they are manually submitted campaigns (project name, task, campaign
-- details, up to 6 steps) that a user curates and confirms in Telegram
-- before they are stored. They live in their own table, separate from the
-- discovery scan's nft_projects. The dedup key is the lowercased X handle.
create table if not exists public.projects (
  id bigint generated always as identity primary key,
  -- The project's X handle - lowercased so the unique index dedupes
  -- regardless of how X happens to capitalise the account.
  handle text not null,
  name text not null default '',
  -- X profile snapshot, fetched when the listing is confirmed.
  avatar text not null default '',
  banner text not null default '',
  bio text not null default '',
  followers bigint not null default 0,
  following bigint not null default 0,
  verified boolean not null default false,
  joined text not null default '',
  -- Campaign data produced by the bot (task / details / steps / prize).
  task text not null default '',
  details text not null default '',
  steps jsonb not null default '[]'::jsonb,
  prize_pool text not null default '',
  -- Optional link to the campaign's own page (provided in the bot after the
  -- X handle; empty when skipped).
  campaign_url text not null default '',
  -- Where the row came from (reserved for future channels; 'telegram' now).
  source text not null default 'telegram',
  -- 'listed' = published to the site, 'removed' = hidden (reserved).
  status text not null default 'listed'
    check (status in ('listed', 'removed')),
  listed_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists projects_handle_key
  on public.projects (lower(handle));

create index if not exists projects_status_idx
  on public.projects (status);

create index if not exists projects_listed_at_idx
  on public.projects (listed_at desc);

-- Tables created before these columns existed need them added explicitly -
-- `create table if not exists` is a no-op on an existing table, so the new
-- fields must be added with standalone alters. Idempotent - safe to re-run.
alter table public.projects add column if not exists prize_pool text not null default '';
alter table public.projects add column if not exists campaign_url text not null default '';

-- One row per first-time visitor's onboarding/follow flow (the modal that
-- asks them to follow Valor). Keyed by a client-generated session id; each
-- step of the flow stamps its own timestamp so the funnel is fully visible.
-- Idempotent - safe to re-run.
create table if not exists public.onboarding (
  id bigint generated always as identity primary key,
  session_id text not null,
  first_visit_at timestamptz not null default now(),
  modal_shown_at timestamptz,
  follow_clicked_at timestamptz,
  detection_completed_at timestamptz,
  continue_clicked_at timestamptz,
  completed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create unique index if not exists onboarding_session_key
  on public.onboarding (session_id);
