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

-- One row per Gems Finding API call (successful, partial, or failed) so there
-- is a complete history of every scheduled run.
create table if not exists public.gems_scan_logs (
  id bigint generated always as identity primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null check (status in ('success', 'partial', 'failed')),
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
