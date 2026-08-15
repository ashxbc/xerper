# Xerper

Next.js 16 app that turns X (Twitter) activity into shareable "proof of work"
cards, plus an **Alpha Terminal** that surfaces pre-mint NFT projects found by
scanning X. The discovery scan runs automatically every 3 hours and stores
everything in Supabase so the site always reflects the latest gems.

## Stack

- Next.js 16 (App Router), React 19, Tailwind CSS 4
- X's internal GraphQL endpoints via a pool of burner accounts
- Groq (LLM) classifies candidate accounts as NFT projects or not
- Supabase (Postgres) stores discovered projects + every scan run

## Getting started

```bash
npm install
npm run dev
```

Environment: copy `.env.local.example` to `.env.local` and fill in:

- **X burners** - `X_AUTH_TOKEN_1..3` / `X_CT0_1..3` (plus optional
  `X_DISCOVERY_AUTH_TOKEN` / `X_DISCOVERY_CT0` for the dedicated discovery
  burner), `PYTHON_BIN` (unused legacy), `GROQ_API_KEY`, `DISCOVERY_SECRET`.
- **Supabase** - see below.

## Supabase setup (gems storage)

1. Create a free project at <https://supabase.com>.
2. Open the **SQL Editor** and run `supabase/schema.sql` - creates two tables:
   - `nft_projects` - every discovered project. `handle` (lowercased) is the
     unique dedup key; `status` is `added` (published to the site) or
     `rejected`; `discovered_at` / `added_at` / `processed` record the
     lifecycle so duplicates can never be re-added.
   - `gems_scan_logs` - one row per scan run (success/partial/failed, how many
     projects were found / new / skipped as duplicates, error details).
3. Run `supabase/seed.sql` to preload the 5 verified projects already found
   (so the site renders gems before the first scheduled scan). Idempotent.
4. Add these env vars (see `supabase/.env.example`):
   - `NEXT_PUBLIC_SUPABASE_URL` - Project Settings > API > Project URL
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` - API > anon public
   - `SUPABASE_SERVICE_ROLE_KEY` - API > service_role (**server only**, never
     in the browser)
   - `CRON_SECRET` - any random string guarding the scan endpoint

No RLS policies are needed: the site never talks to Supabase from the browser.
All reads/writes go through API routes using the service-role key server-side.

## Scheduling the scan (every 3 hours)

The scan itself is `GET /api/gems/run?cron=<CRON_SECRET>`. It runs a fresh
scan, upserts new projects into `nft_projects` (existing handles are skipped
as duplicates), and writes a row to `gems_scan_logs`. Pick one scheduler:

- **GitHub Actions (free, every 3 hours)** - `.github/workflows/gems-scan.yml`
  already declares the `0 */3 * * *` schedule. Add two secrets in the repo
  (Settings > Secrets and variables > Actions):
  - `GEMS_RUN_URL` - your deployed app URL, e.g. `https://your-app.vercel.app`
  - `CRON_SECRET` - same value as the `CRON_SECRET` env var on Vercel
  The job waits for the scan to finish (up to ~5 min) and reports the real
  HTTP status; a non-2xx response - or a missing secret - fails the job
  loudly so a broken trigger shows up red in the Actions tab instead of
  silently doing nothing. You can also hit "Run workflow" there to trigger
  a scan manually at any time.

### Verifying the scheduler

Every call to `/api/gems/run` now opens a `running` row in `gems_scan_logs`
the moment it arrives, then finalizes it to `success` / `partial` / `failed`
when the scan finishes. So Supabase tells you the truth about the schedule:

- Rows appearing every 3 hours = the scheduler is healthy.
- A `running` row stuck on `running` = the call arrived but the function died
  mid-scan (check the budget section below).
- No rows at all = the workflow never fired or the secrets are missing -
  check the Actions tab for scheduled runs and the secret values.

One-time migration: if you created the tables before this change, re-run
`supabase/schema.sql` - it widens the scan-logs `status` column to admit
`running` rows (idempotent, safe to re-run).
- **Vercel Cron (Hobby = once per day)** - free Vercel accounts only allow one
  cron invocation per day (`0 */3 * * *` fails deployment on Hobby). If you
  accept a daily scan instead, add a `vercel.json` with:
  ```json
  { "crons": [{ "path": "/api/gems/run?cron=${CRON_SECRET}", "schedule": "0 3 * * *" }] }
  ```
- **Self-hosted** - add a crontab line:
  ```
  0 */3 * * * curl -fsS "https://YOUR-HOST/api/gems/run?cron=YOUR_CRON_SECRET" -o /dev/null
  ```

### Free-plan (Vercel Hobby) scan budget

Hobby caps function duration at **300s** and the routes declare
`maxDuration = 300` accordingly. The scan budget is configurable via env vars
and defaults to values that fit inside that window:

- `DISCOVERY_PAGES` (default 2) - pages fetched per query
- `DISCOVERY_PAGE_SIZE` (default 50) - posts per page
- `DISCOVERY_MAX_CANDIDATES` (default 25) - unique handles evaluated per run
- `DISCOVERY_MAX_FOLLOWERS` (default 1000) - follower ceiling
- `DISCOVERY_TIME_BUDGET_MS` (default 240000) - hard wall-clock cap on the
  scan so it always finishes inside the 300s function limit and actually gets
  stored + logged. Lower it if scans still time out.

If scans time out at 300s, lower `DISCOVERY_MAX_CANDIDATES` (the dominant
cost); if you upgrade to Pro or self-host, raise the limits and bump the
routes' `maxDuration` back up.

After each successful run the website updates automatically: `/api/gems`
reads the `added` projects straight from Supabase (lowest follower count
first), and the Alpha Terminal renders whatever is stored.

## How it works

- **Proof of Work** (`/api/impressions`) - searches X for a user's posts
  mentioning a project and sums their view counts into a cumulative growth
  series, rendered as a shareable card (PNG export included).
- **Discovery scan** (`src/lib/x/discovery.ts`) - runs fixed high-intent
  queries for pre-mint NFT launches, dedupes candidate handles, hard-gates on
  follower count (< 1,000), rejects accounts already minting (regex + OpenSea
  check + Groq), and classifies the rest with Groq.
- **Burners** (`src/lib/x/accounts.ts`) - three user-facing burners at
  1 req/sec, plus a dedicated discovery burner at 5 req/sec so scans never
  compete with real users' requests.
